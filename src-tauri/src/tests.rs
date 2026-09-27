// Link-interceptor contract tests.
//
// These verify the security-critical behaviors of the link interceptor
// (link-interceptor.js) without a browser: the script must
//   1. never call window.open on the raw OS/browser surface — there is no
//      window.open call in the interceptor at all;
//   2. never use any external-browser API (shell.open, _blank targets are
//      intercepted, not honored);
//   3. install its click listener in the CAPTURE phase (document_start timing
//      demands it — third-party handlers must not see the click first);
//   4. route through the Tauri `open_in_app_browser` invoke for cross-origin
//      and new-window navigations, falling back to same-tab navigation;
//   5. only act on http/https URLs (no javascript:, no fragments, no mailto).
//
// Contract: links clicked in Muse Code or the Muse panel open in the app's
// INTERNAL browser windows, never in the external system browser.

#[cfg(test)]
mod link_interceptor {
    const SRC: &str = include_str!("link-interceptor.js");

    #[test]
    fn intercepts_all_link_clicks_in_capture_phase() {
        assert!(
            SRC.contains(r#"document.addEventListener("#),
            "must attach a document-level click listener"
        );
        assert!(
            SRC.contains("\"click\","),
            "the listener must be on click events"
        );
        // capture=true is the third argument; required so page JS can't
        // beat us to the click.
        assert!(
            SRC.contains("true\n  );") || SRC.contains("true)"),
            "listener must run in the capture phase"
        );
        assert!(SRC.contains("closest(\"a[href]\")"), "must find the anchor");
    }

    #[test]
    fn external_and_new_window_links_go_to_in_app_browser() {
        assert!(
            SRC.contains("open_in_app_browser"),
            "must route through the in-app-browser Tauri command"
        );
        assert!(
            SRC.contains(r#"target === "_blank""#),
            "target=_blank links must be intercepted, never honored natively"
        );
        assert!(
            SRC.contains("url.origin !==") && SRC.contains(".origin"),
            "cross-origin links must be routed in-app"
        );
        assert!(
            SRC.contains("e.preventDefault()"),
            "intercepted clicks must be prevented from navigating natively"
        );
    }

    #[test]
    fn no_external_browser_surface_anywhere() {
        assert!(
            !SRC.contains("window.open("),
            "interceptor must not open native windows/popups"
        );
        assert!(
            !SRC.contains("shell.open"),
            "interceptor must never call an external-browser API"
        );
        assert!(
            !SRC.contains("location.replace(") && !SRC.contains("location.assign("),
            "no indirect navigation APIs"
        );
    }

    #[test]
    fn only_http_https_are_intercepted() {
        assert!(
            SRC.contains(r#"url.protocol !== "http:" && url.protocol !== "https:""#),
            "must only intercept http/https"
        );
        assert!(
            SRC.contains("javascript:"),
            "must explicitly skip javascript: links"
        );
        assert!(
            SRC.contains(r#"href.charAt(0) === "#"#),
            "must skip in-page fragment links"
        );
    }

    #[test]
    fn in_app_browser_windows_route_window_open_internally() {
        assert!(
            SRC.contains("__MCD_IN_APP_BROWSER__"),
            "browser windows must be flagged by the Rust side"
        );
        assert!(
            SRC.contains("window.open = function"),
            "window.open must be overridden in browser windows"
        );
    }

    #[test]
    fn idempotent_install() {
        assert!(
            SRC.contains("__mcdLinksInstalled"),
            "script may run once per document (webview reloads)"
        );
    }
}

#[cfg(test)]
mod panel_contract {
    use crate::panel;

    #[test]
    fn link_interceptor_script_is_nonempty() {
        assert!(!panel::LINK_INTERCEPTOR.trim().is_empty());
    }

    #[test]
    fn mic_permission_is_allowlisted_for_microphone_only() {
        use tauri::webview::{PermissionKind, PermissionResponse};
        assert!(matches!(
            panel::mic_permission(PermissionKind::Microphone),
            PermissionResponse::Allow
        ));
        // Other permission kinds must NOT be auto-granted.
        assert!(!matches!(
            panel::mic_permission(PermissionKind::Camera),
            PermissionResponse::Allow
        ));
    }

    #[test]
    fn panel_defaults_keep_muse_url_https() {
        let cfg = panel::PanelConfig::default();
        assert!(cfg.muse_url.starts_with("https://"));
        assert!(cfg.split > 0.0 && cfg.split < 1.0);
    }
}
