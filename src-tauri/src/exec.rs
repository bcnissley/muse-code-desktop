//! Headless one-shot command execution (`muse exec --json`).
//!
//! Unlike the interactive PTY sessions in `pty.rs`, these are direct
//! `std::process::Command` spawns with piped stdout/stderr and no
//! pseudoterminal. On Windows the command is routed through `cmd /C` so
//! `.cmd`/`.bat` shims (e.g. npm-installed CLIs) resolve via PATHEXT.
//! Each output line is forwarded to the frontend as a Tauri event; when the
//! child exits, an exit event with its code follows.
//! The chat panel uses this so bubbles stay clean instead of scraping the
//! interactive TUI.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// On Windows, one-shot child processes must not flash a console window.
#[cfg(windows)]
fn no_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
}

#[cfg(not(windows))]
fn no_console_window(_cmd: &mut Command) {}

pub struct ExecChild {
    child: Arc<Mutex<Child>>,
}

pub struct ExecState(pub Mutex<HashMap<String, ExecChild>>);

#[tauri::command]
pub fn exec_start(
    app: AppHandle,
    state: State<'_, ExecState>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: String,
) -> Result<(), String> {
    {
        let procs = state.0.lock().map_err(|e| e.to_string())?;
        if procs.contains_key(&id) {
            return Err(format!("exec '{id}' already running"));
        }
    }
    if command.trim().is_empty() {
        return Err("exec: empty command".to_string());
    }
    // On Windows the CLI is usually a `.cmd` shim (npm global bin) which
    // CreateProcess cannot execute directly — route through cmd.exe so
    // PATHEXT resolution applies. (Unix: direct spawn is fine.)
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&command);
        c
    } else {
        Command::new(&command)
    };
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_console_window(&mut cmd);
    if !cwd.trim().is_empty() {
        cmd.current_dir(&cwd);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{command}': {e}"))?;
    let stdout = child.stdout.take().ok_or("exec: no stdout pipe")?;
    let stderr = child.stderr.take().ok_or("exec: no stderr pipe")?;

    let shared = Arc::new(Mutex::new(child));
    // Insert BEFORE the reader thread starts so exec_kill works mid-run.
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), ExecChild { child: shared.clone() });

    // Pump output lines -> frontend events on background threads, then
    // report the exit code. The lock is only ever held for short
    // try_wait polls so exec_kill can always grab it to kill mid-run.
    let app_c = app.clone();
    let id_c = id.clone();
    let shared_c = shared.clone();
    std::thread::spawn(move || {
        let stderr_handle = std::thread::spawn({
            let app_e = app_c.clone();
            let id_e = id_c.clone();
            move || {
                for line in BufReader::new(stderr).lines() {
                    match line {
                        Ok(l) => {
                            let _ = app_e.emit(&format!("exec-output-{id_e}"), l);
                        }
                        Err(_) => break,
                    }
                }
            }
        });
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) => {
                    let _ = app_c.emit(&format!("exec-output-{id_c}"), l);
                }
                Err(_) => break,
            }
        }
        let _ = stderr_handle.join();

        let code: i64 = loop {
            let done = match shared_c.lock() {
                Ok(mut c) => match c.try_wait() {
                    Ok(Some(status)) => Some(status.code().unwrap_or(-1) as i64),
                    Ok(None) => None,
                    Err(_) => Some(-1),
                },
                Err(_) => Some(-1),
            };
            match done {
                Some(code) => break code,
                None => std::thread::sleep(Duration::from_millis(50)),
            }
        };

        // Drop our handle so a naturally-exited child is reaped/cleaned up.
        // (If exec_kill already removed it, this is a no-op.)
        if let Ok(mut procs) = app_c.state::<ExecState>().0.lock() {
            procs.remove(&id_c);
        }
        let _ = app_c.emit(&format!("exec-exit-{id_c}"), code);
    });
    Ok(())
}

#[tauri::command]
pub fn exec_kill(state: State<'_, ExecState>, id: String) -> Result<(), String> {
    let mut procs = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = procs.remove(&id) {
        if let Ok(mut child) = entry.child.lock() {
            let _ = child.kill();
        }
    }
    Ok(())
}
