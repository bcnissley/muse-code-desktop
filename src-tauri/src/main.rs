//! Muse Code Desktop — Tauri backend.
//!
//! Hosts the Muse Code CLI in an embedded PTY and shows a side-by-side Muse
//! webview panel. See README.md for architecture and build notes.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod exec;
mod git;
mod panel;
mod projects;
mod pty;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState(Mutex::new(HashMap::new())))
        .manage(exec::ExecState(Mutex::new(HashMap::new())))
        .manage(panel::PanelState(Mutex::new(panel::PanelConfig::default())))
        .setup(|app| {
            // Primary: one window, two webviews (app + Muse side panel).
            // Falls back to a plain single-webview window if the unstable
            // multi-webview API is unavailable on this machine.
            if let Err(e) = panel::build_multiwebview(app) {
                eprintln!("[muse-code-desktop] multi-webview setup failed ({e}); single-window fallback");
                // The failed attempt may have left a half-built "main" window behind.
                if let Some(w) = app.get_window("main") {
                    let _ = w.close();
                }
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                    .initialization_script(panel::LINK_INTERCEPTOR)
                    .title("Muse Code Desktop")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(1100.0, 680.0)
                    .build()
                    .map_err(|e| format!("fallback window failed: {e}"))?;
                if let Ok(mut cfg) = app.state::<panel::PanelState>().0.lock() {
                    cfg.available = false;
                    cfg.visible = false;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_run_once,
            pty::default_shell,
            exec::exec_start,
            exec::exec_kill,
            projects::project_create_dir,
            projects::project_rename_dir,
            git::gh_available,
            git::gh_auth_status,
            git::gh_auth_login_token,
            git::git_info,
            git::gh_repo_list,
            git::gh_clone,
            git::gh_repo_create,
            git::git_commit,
            git::git_branches,
            git::git_branch_create,
            git::git_branch_switch,
            git::git_push,
            git::git_pull,
            git::gh_fork,
            panel::muse_panel_status,
            panel::set_muse_panel,
            panel::set_muse_code_panel,
            panel::set_muse_split,
            panel::set_muse_url,
            panel::open_muse_url,
            panel::open_in_app_browser,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run muse-code-desktop");
}
