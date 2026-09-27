//! Embedded PTY sessions. The Muse Code CLI runs in a real pseudoterminal
//! so interactive prompts, colors, and auth flows behave exactly like they
//! do in a normal terminal — minus the terminal window.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub struct PtyState(pub Mutex<HashMap<String, PtySession>>);

fn spawn_pair(
    cols: u16,
    rows: u16,
    cwd: &str,
    shell: &str,
) -> Result<
    (
        Box<dyn MasterPty + Send>,
        Box<dyn portable_pty::Child + Send + Sync>,
    ),
    String,
> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;
    let mut cmd = CommandBuilder::new(shell);
    if !cwd.trim().is_empty() {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn '{shell}': {e}"))?;
    Ok((pair.master, child))
}

#[tauri::command]
pub fn default_shell() -> String {
    if cfg!(windows) {
        // powershell is friendlier than cmd for interactive CLIs
        "powershell.exe".to_string()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: String,
    shell: String,
) -> Result<(), String> {
    {
        let sessions = state.0.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(&id) {
            return Err(format!("pty session '{id}' already exists"));
        }
    }
    let (mut master, child) = spawn_pair(cols, rows, &cwd, &shell)?;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = master.take_writer().map_err(|e| e.to_string())?;

    // Pump output -> frontend events on a background thread.
    let app_c = app.clone();
    let id_c = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_c.emit(&format!("pty-output-{id_c}"), text);
                }
                Err(_) => break,
            }
        }
        let _ = app_c.emit(&format!("pty-exit-{id_c}"), ());
    });

    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, PtySession { writer, master, child });
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    let s = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("no pty session '{id}'"))?;
    s.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|e| e.to_string())?;
    let s = sessions
        .get(&id)
        .ok_or_else(|| format!("no pty session '{id}'"))?;
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut s) = sessions.remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

/// Run one command in a throwaway shell and return its captured output.
/// Used for non-interactive checks (e.g. `muse auth status`) without
/// polluting the interactive session.
#[tauri::command]
pub fn pty_run_once(command: String, cwd: String, shell: String) -> Result<String, String> {
    let (mut master, mut child) = spawn_pair(120, 30, &cwd, &shell)?;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = master.take_writer().map_err(|e| e.to_string())?;
    writer
        .write_all(format!("{command}\r").as_bytes())
        .map_err(|e| e.to_string())?;
    writer.write_all(b"exit\r").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    drop(writer);

    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let mut out = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(chunk) => out.extend_from_slice(&chunk),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let exited = matches!(child.try_wait(), Ok(Some(_)));
                if exited || Instant::now() > deadline {
                    while let Ok(chunk) = rx.try_recv() {
                        out.extend_from_slice(&chunk);
                    }
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = child.kill();
    Ok(String::from_utf8_lossy(&out).into_owned())
}
