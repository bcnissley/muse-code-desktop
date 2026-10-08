//! Side-by-side Muse panel + in-app browser.
//!
//! The main window hosts two webviews (Tauri `unstable` multi-webview API):
//!   - "app-view": the React Muse Code workspace (left)
//!   - "muse-view": the Muse web client, side by side (right)
//!
//! Link contract (user requirement): links clicked in ANY webview open in the
//! app's internal browser windows ("browser-N"), never in the system browser.
//! This is enforced two ways:
//!   1. `link-interceptor.js` (document_start) reroutes link clicks, and
//!   2. `on_new_window` ALLOWS popups as real in-app windows. OAuth flows
//!      call window.open() and need a live opener handle back — denying the
//!      popup made pages report "popups blocked" (issue #2).

use std::sync::{
    atomic::{AtomicU32, Ordering},
    Mutex,
};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse, WebviewBuilder};
use tauri::window::WindowBuilder;

pub const LINK_INTERCEPTOR: &str = include_str!("link-interceptor.js");

#[derive(Clone)]
pub struct PanelConfig {
    pub available: bool, // false when multi-webview setup failed (fallback mode)
    pub visible: bool,
    pub split: f64, // fraction of window width given to the Muse Code side
    pub code_visible: bool, // false = Muse Code side collapsed to a slim strip
    pub muse_url: String,
}

impl Default for PanelConfig {
    fn default() -> Self {
        Self {
            available: true,
            visible: true,
            split: 0.58,
            code_visible: true,
            muse_url: "https://muse.ai".to_string(),
        }
    }
}

pub struct PanelState(pub Mutex<PanelConfig>);

impl PanelState {
    pub fn mark_unavailable(&self) {
        if let Ok(mut cfg) = self.0.lock() {
            cfg.available = false;
            cfg.visible = false;
        }
    }
}

#[derive(Clone, serde::Serialize)]
pub struct PanelStatus {
    pub available: bool,
    pub visible: bool,
    pub split: f64,
    pub code_visible: bool,
}

fn status_of(app: &AppHandle) -> Result<PanelStatus, String> {
    let state = app.state::<PanelState>();
    let cfg = state.0.lock().map_err(|e| e.to_string())?;
    Ok(PanelStatus {
        available: cfg.available,
        visible: cfg.visible && cfg.available,
        split: cfg.split,
        code_visible: cfg.code_visible,
    })
}

pub fn mic_permission(kind: PermissionKind) -> PermissionResponse {
    match kind {
        PermissionKind::Microphone => PermissionResponse::Allow,
        _ => PermissionResponse::Default,
    }
}

fn window_dims(app: &AppHandle) -> Option<(f64, f64)> {
    let w = app.get_window("main")?;
    let size = w.inner_size().ok()?;
    let scale = w.scale_factor().unwrap_or(1.0);
    Some((size.width as f64 / scale, size.height as f64 / scale))
}

/// Build the main window with both webviews. Called from setup().
/// On any failure the caller should fall back to a plain single-webview window.
pub fn build_multiwebview(app: &mut tauri::App) -> Result<(), String> {
    let window = WindowBuilder::new(app, "main")
        .title("Muse Code Desktop")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1100.0, 680.0)
        .build()
        .map_err(|e| format!("main window build failed: {e}"))?;

    let app_view = WebviewBuilder::new("app-view", WebviewUrl::App("index.html".into()))
        .initialization_script(LINK_INTERCEPTOR)
        .on_permission_request(|_, kind| mic_permission(kind))
        .on_new_window(|_, _| {
            // Popups (window.open) are allowed as REAL in-app windows.
            // OAuth flows need a live opener handle; denying the popup
            // made the page see `null` and report popups as blocked.
            // Still never the OS browser (issue #2).
            NewWindowResponse::Allow
        });

    // `add_child` requires tauri's `unstable` cargo feature (see Cargo.toml).
    window
        .add_child(
            app_view,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1440.0, 900.0),
        )
        .map_err(|e| format!("app-view add_child failed: {e}"))?;

    // Muse side panel — failure here is non-fatal (app still works solo).
    if let Err(e) = ensure_muse_view(&app.handle()) {
        eprintln!("[muse-code-desktop] muse panel unavailable: {e}");
        app.handle().state::<PanelState>().mark_unavailable();
    }
    relayout(&app.handle());

    let h = app.handle().clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_)) {
            relayout(&h);
        }
    });
    Ok(())
}

/// Create the Muse child webview if it doesn't exist yet.
pub fn ensure_muse_view(app: &AppHandle) -> Result<(), String> {
    let w = app.get_window("main").ok_or("main window not found")?;
    if w.get_webview("muse-view").is_some() {
        return Ok(());
    }
    let (visible, split, muse_url) = {
        let state = app.state::<PanelState>();
        let cfg = state.0.lock().map_err(|e| e.to_string())?;
        (cfg.visible, cfg.split, cfg.muse_url.clone())
    };
    let parsed = url::Url::parse(&muse_url).map_err(|e| format!("bad muse url: {e}"))?;
    let (win_w, win_h) = window_dims(app).unwrap_or((1440.0, 900.0));
    let x = (win_w * split).round();

    let builder = WebviewBuilder::new("muse-view", WebviewUrl::External(parsed))
        .initialization_script(LINK_INTERCEPTOR)
        .on_permission_request(|_, kind| mic_permission(kind))
        .on_new_window(|_, _| {
            // Popups (window.open) are allowed as REAL in-app windows.
            // OAuth flows need a live opener handle; denying the popup
            // made the page see `null` and report popups as blocked.
            // Still never the OS browser (issue #2).
            NewWindowResponse::Allow
        })
        .disable_drag_drop_handler();

    match w.add_child(
        builder,
        LogicalPosition::new(x, 0.0),
        LogicalSize::new((win_w - x).max(240.0), win_h),
    ) {
        Ok(view) => {
            if !visible {
                let _ = view.hide();
            }
            Ok(())
        }
        Err(e) => Err(format!("muse-view add_child failed: {e}")),
    }
}

/// Keep the Muse webview glued to the right edge of the window.
/// When the Muse Code side is hidden, the app-view collapses to a slim strip
/// (holding the "Show Muse Code" affordance) and Muse takes the rest.
pub fn relayout(app: &AppHandle) {
    const CODE_STRIP: f64 = 60.0;
    let state = app.state::<PanelState>();
    let (available, visible, split, code_visible) = match state.0.lock() {
        Ok(cfg) => (
            cfg.available,
            cfg.visible,
            cfg.split.clamp(0.25, 0.8),
            cfg.code_visible,
        ),
        Err(_) => return,
    };
    if !available {
        return;
    }
    let Some(w) = app.get_window("main") else {
        return;
    };
    let Ok(size) = w.inner_size() else {
        return;
    };
    let scale = w.scale_factor().unwrap_or(1.0);
    let (win_w, win_h) = (size.width as f64 / scale, size.height as f64 / scale);

    // Muse Code hidden: slim strip for app-view, everything else for Muse.
    if !code_visible {
        if let Some(app_view) = w.get_webview("app-view") {
            let _ = app_view.set_position(LogicalPosition::new(0.0, 0.0));
            let _ = app_view.set_size(LogicalSize::new(CODE_STRIP, win_h));
            let _ = app_view.show();
        }
        if let Some(view) = w.get_webview("muse-view") {
            let _ = view.set_position(LogicalPosition::new(CODE_STRIP, 0.0));
            let _ = view.set_size(LogicalSize::new((win_w - CODE_STRIP).max(240.0), win_h));
            let _ = view.show();
        }
        return;
    }

    let x = (win_w * split).round();

    // Resize the app-view to take the left portion.
    if let Some(app_view) = w.get_webview("app-view") {
        if visible {
            let _ = app_view.set_position(LogicalPosition::new(0.0, 0.0));
            let _ = app_view.set_size(LogicalSize::new(x.max(320.0), win_h));
        } else {
            let _ = app_view.set_position(LogicalPosition::new(0.0, 0.0));
            let _ = app_view.set_size(LogicalSize::new(win_w, win_h));
        }
    }

    let Some(view) = w.get_webview("muse-view") else {
        return;
    };
    if !visible {
        let _ = view.hide();
        return;
    }
    let _ = view.set_position(LogicalPosition::new(x, 0.0));
    let _ = view.set_size(LogicalSize::new((win_w - x).max(240.0), win_h));
    let _ = view.show();
}

static BROWSER_SEQ: AtomicU32 = AtomicU32::new(0);

fn open_browser_window(app: &AppHandle, url: &str) -> Result<(), String> {
    let n = BROWSER_SEQ.fetch_add(1, Ordering::SeqCst);
    let label = format!("browser-{n}");
    let parsed = url::Url::parse(url).map_err(|e| format!("bad url: {e}"))?;
    tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .initialization_script(LINK_INTERCEPTOR)
        .title("Browser")
        .inner_size(1000.0, 720.0)
        .min_inner_size(640.0, 480.0)
        .center()
        .on_new_window(|_, _| {
            // Popups (window.open) are allowed as REAL in-app windows.
            // OAuth flows need a live opener handle; denying the popup
            // made the page see `null` and report popups as blocked.
            // Still never the OS browser (issue #2).
            NewWindowResponse::Allow
        })
        .build()
        .map(|_| ())
        .map_err(|e| format!("failed to open in-app browser: {e}"))
}

/// Open a URL in the app's internal browser. Links never hit the OS browser.
#[tauri::command]
pub async fn open_in_app_browser(app: AppHandle, url: String) -> Result<(), String> {
    // MUST stay async: creating windows in a sync command deadlocks WebView2 on Windows.
    open_browser_window(&app, &url)
}

#[tauri::command]
pub fn muse_panel_status(app: AppHandle) -> Result<PanelStatus, String> {
    status_of(&app)
}

#[tauri::command]
pub fn set_muse_panel(app: AppHandle, visible: bool) -> Result<PanelStatus, String> {
    {
        let state = app.state::<PanelState>();
        let mut cfg = state.0.lock().map_err(|e| e.to_string())?;
        cfg.visible = visible;
    }
    // Lazily create the view if it was never built.
    if visible {
        if let Err(e) = ensure_muse_view(&app) {
            eprintln!("[muse-code-desktop] ensure_muse_view failed: {e}");
        }
    }
    relayout(&app);
    status_of(&app)
}

#[tauri::command]
pub fn set_muse_code_panel(app: AppHandle, visible: bool) -> Result<PanelStatus, String> {
    {
        let state = app.state::<PanelState>();
        let mut cfg = state.0.lock().map_err(|e| e.to_string())?;
        cfg.code_visible = visible;
        // Hiding the code side is pointless without the Muse panel — show it.
        if !visible {
            cfg.visible = true;
        }
    }
    // Lazily create the Muse view if it was never built.
    if let Err(e) = ensure_muse_view(&app) {
        eprintln!("[muse-code-desktop] ensure_muse_view failed: {e}");
    }
    relayout(&app);
    status_of(&app)
}

#[tauri::command]
pub fn set_muse_split(app: AppHandle, ratio: f64) -> Result<PanelStatus, String> {
    {
        let state = app.state::<PanelState>();
        let mut cfg = state.0.lock().map_err(|e| e.to_string())?;
        cfg.split = ratio.clamp(0.25, 0.8);
    }
    relayout(&app);
    status_of(&app)
}

#[tauri::command]
pub fn set_muse_url(app: AppHandle, url: String) -> Result<PanelStatus, String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("bad muse url: {e}"))?;
    {
        let state = app.state::<PanelState>();
        let mut cfg = state.0.lock().map_err(|e| e.to_string())?;
        cfg.muse_url = url;
    }
    if let Some(w) = app.get_window("main") {
        if let Some(v) = w.get_webview("muse-view") {
            let _ = v.navigate(parsed);
        }
    }
    status_of(&app)
}

/// Navigate the Muse side panel somewhere else (docs, settings) without leaving the app.
#[tauri::command]
pub fn open_muse_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("bad url: {e}"))?;
    let w = app.get_window("main").ok_or("main window not found")?;
    let v = w.get_webview("muse-view").ok_or("muse panel not available")?;
    v.navigate(parsed).map_err(|e| e.to_string())
}
