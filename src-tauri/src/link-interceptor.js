// Link interceptor — injected at document_start into every Tauri webview.
//
// CONTRACT (from the user): links clicked inside the Muse panel or anywhere
// else in the app must open in the app's INTERNAL browser handling, never in
// the external system browser. Same-origin, same-window navigations (login
// redirects, SPA routing) are left completely alone.
//
// Mechanism: capture-phase click listener. Cross-origin links, target=_blank
// links, and modifier/middle clicks are prevented and routed to the Rust
// `open_in_app_browser` command, which opens a Tauri "browser-N" window.
// Native popups (window.open / missed target=_blank) are additionally caught
// by the Rust `on_new_window` handler, which denies them and opens the
// in-app browser instead.
(function () {
  if (window.__mcdLinksInstalled) return;
  window.__mcdLinksInstalled = true;

  // Pure routing decision, exposed on window for unit tests.
  // Returns "in-app" (open in the internal browser), "allow" (let the
  // webview navigate normally), or "ignore" (not a navigable http link).
  function routeDecision(href, pageHref, target, withModifiers) {
    if (!href || href.charAt(0) === "#" || href.indexOf("javascript:") === 0)
      return "ignore";
    var url;
    try {
      url = new URL(href, pageHref);
    } catch (err) {
      return "ignore";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "ignore";
    var external = url.origin !== new URL(pageHref).origin;
    var wantsNewWindow = target === "_blank" || !!withModifiers;
    return external || wantsNewWindow ? "in-app" : "allow";
  }
  window.__mcdRouteDecision = routeDecision;

  function openInApp(url) {
    try {
      var t = window.__TAURI__ && window.__TAURI__.core;
      if (t && t.invoke) {
        t.invoke("open_in_app_browser", { url: url }).catch(function () {
          window.location.href = url; // bridge hiccup: still stay in-app
        });
        return;
      }
    } catch (e) { /* fall through */ }
    window.location.href = url;
  }

  document.addEventListener(
    "click",
    function (e) {
      var el = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!el) return;
      var decision = routeDecision(
        el.getAttribute("href"),
        window.location.href,
        el.target,
        e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1
      );
      if (decision === "in-app") {
        e.preventDefault();
        e.stopPropagation();
        var url = new URL(el.getAttribute("href"), window.location.href);
        openInApp(url.href);
      }
      // "allow" and "ignore": do nothing, the webview handles it natively.
    },
    true
  );

  // Inside in-app browser windows, window.open is also routed in-app.
  // (The flag is prepended to this script by the Rust side for those windows.)
  if (window.__MCD_IN_APP_BROWSER__) {
    window.open = function (url) {
      if (url) openInApp(String(url));
      return null;
    };
  }
})();
