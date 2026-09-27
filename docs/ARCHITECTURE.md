// Workspace layout
// ----------------
// One Tauri "main" window with TWO child webviews (needs tauri `unstable`):
//   - "app-view": the React Muse Code workspace (left)
//   - "muse-view": the Muse web client at muse.ai (right, draggable split)
//
// If the multi-webview setup fails, the app falls back to a single webview
// (Muse Code workspace only).

// Terminal
// --------
// The Muse Code CLI runs in a real PTY (portable-pty) inside Rust.
// xterm.js renders it in the drawer. The composer sends prompts by writing
// into the PTY's stdin (Enter submits, exactly like the terminal).

// Links
// -----
// CONTRACT: links clicked ANYWHERE in the app (Muse Code workspace, Muse
// panel, terminal, in-app browser windows) open in the app's INTERNAL
// browser windows, NEVER in the external system browser.
// Enforced by:
//   - link-interceptor.js injected at document_start in every webview
//   - on_new_window denying native popups and opening browser-N windows
//   - xterm link provider calling open_in_app_browser
// Covered by the link_interceptor tests in src/tests.rs.

// Browser windows
// ---------------
// open_in_app_browser opens a "browser-N" Tauri WebviewWindow with the
// link interceptor injected. Popups inside those windows are also denied and
// re-opened as further browser windows. They are intentionally chrome-less:
// the window itself is the browser UI. No external-browser API is used
// anywhere in the backend.

// Microphone
// ----------
// Web Speech API in the React layer for dictation/hold-to-talk. Mic
// permission is allowlisted in the webview permission callback; every other
// permission kind is left at the WebView2 default (prompt/deny).
