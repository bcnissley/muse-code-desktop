//! Windows: stop child processes from flashing console windows.
//!
//! One-shot spawns (`cmd /C …`, `git`, `gh`) are console-subsystem programs.
//! When the app itself has no console (release GUI build), each such child
//! allocates a *visible* console window — and `CREATE_NO_WINDOW` on the
//! direct child does not stop grandchildren (e.g. `node.exe` launched by an
//! npm `.cmd` shim) from allocating their own. Allocating one hidden console
//! for the app process at startup fixes every depth at once: children simply
//! inherit the hidden console and never create a window.

#[cfg(windows)]
pub fn ensure_hidden_console() {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "C" {
        fn AllocConsole() -> i32;
        fn GetConsoleWindow() -> *mut c_void;
    }
    #[link(name = "user32")]
    extern "C" {
        fn ShowWindow(h_wnd: *mut c_void, n_cmd_show: i32) -> i32;
    }
    const SW_HIDE: i32 = 0;

    // SAFETY: plain Win32 calls, no preconditions beyond a valid thread.
    // AllocConsole fails (returns 0) when the process already has a console —
    // e.g. launched from a terminal via `tauri dev` — which is fine: children
    // then use that console and no new window pops.
    unsafe {
        if AllocConsole() != 0 {
            let hwnd = GetConsoleWindow();
            if !hwnd.is_null() {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
    }
}

#[cfg(not(windows))]
pub fn ensure_hidden_console() {}
