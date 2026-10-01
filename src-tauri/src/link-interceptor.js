// Link interceptor — injected at document_start into every Tauri webview.
//
// CONTRACT (from the user): links clicked inside the Muse panel or anywhere
// else in the app must open in the app's INTERNAL browser handling, never in
// the external system browser. Same-origin, same-window navigations (login
// redirects, SPA routing) are left completely alone.
//
// Mechanism:
//   - capture-phase click listener: cross-origin links, target=_blank links,
//     and modifier/middle clicks are prevented and routed to the Rust
//     `open_in_app_browser` command, which opens a Tauri "browser-N" window.
//   - popups (window.open): NOT intercepted here. The Rust `on_new_window`
//     handler allows them as real in-app windows, because OAuth flows need
//     a live opener handle (denying them made pages report popups blocked).
//   - capture-phase copy listener (issue #1): when the selection sits inside
//     a single link, the URL goes on the clipboard instead of the label text.
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

  // Pure copy decision, exposed on window for unit tests.
  // Returns the href to put on the clipboard when the selection sits inside
  // a single anchor, or null when default copy behavior should apply.
  function copyHrefForSelection(anchorNode, focusNode, isCollapsed, pageHref) {
    if (isCollapsed) return null;
    var linkOf = function (node) {
      var el = node && node.nodeType === 1 ? node : node && node.parentElement;
      return el && el.closest ? el.closest("a[href]") : null;
    };
    var a1 = linkOf(anchorNode);
    var a2 = linkOf(focusNode);
    if (!a1 || a1 !== a2) return null;
    try {
      return new URL(a1.getAttribute("href"), pageHref).href;
    } catch (err) {
      return null;
    }
  }
  window.__mcdCopyHref = copyHrefForSelection;

  // MCD-ISSUE-1-V3 helpers: the chat renders links as rich unfurl cards
  // rather than <a> elements, so anchor detection can't find them. Whatever
  // the page's copy machinery is, its output is unmistakable: a bare
  // markdown link "[text](url)". Detect that shape at the clipboard level
  // and keep only the URL.
  function mdLinkToUrl(t) {
    if (typeof t !== "string") return t;
    var m = /^\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/.exec(t);
    return m ? m[2] : t;
  }
  function selectionText() {
    try {
      var sel = window.getSelection ? window.getSelection() : null;
      return sel ? sel.toString() : "";
    } catch (e) {
      return "";
    }
  }

  // Wrap the async clipboard write: if the page copies a bare markdown
  // link via keydown + writeText (no copy event fires), transform it to
  // the URL here. Raw-markdown selections (selection text === written
  // text) pass through untouched.
  (function () {
    try {
      var nav = window.navigator;
      var clip = nav && nav.clipboard;
      if (!clip || typeof clip.writeText !== "function") return;
      if (clip.__mcdWriteTextWrapped) return;
      var origWriteText = clip.writeText.bind(clip);
      clip.writeText = function (t) {
        var s = t;
        try {
          var str = String(t);
          var url = mdLinkToUrl(str);
          if (url !== str) {
            var sel = selectionText();
            if (!sel || sel.trim() !== str.trim()) s = url;
          }
        } catch (e) {
          s = t;
        }
        return origWriteText(s);
      };
      clip.__mcdWriteTextWrapped = true;
    } catch (e) {
      /* clipboard API unavailable; the copy-event path still applies */
    }
  })();

  // Issue #1: selecting a rendered markdown link and copying grabbed the
  // visible label text. Copy the URL instead when it's a single link.
  //
  // MCD-ISSUE-1-V2: the chat page serializes selections to markdown
  // ([text](url)) through machinery a document-level listener could not
  // preempt (v1's stopImmediatePropagation still lost -- verified via a
  // plain-text address-bar paste). So we listen on window in the capture
  // phase: installed at document_start we are always registered first, run
  // first at every level/phase, and shut the door behind us. Belt and
  // braces: we also intercept Ctrl/Cmd+C at keydown for pages that copy
  // through the async clipboard API without ever firing a copy event.
  window.addEventListener(
    "copy",
    function (e) {
      try {
        var sel = window.getSelection ? window.getSelection() : null;
        if (!sel || sel.rangeCount === 0) return;
        var href = copyHrefForSelection(
          sel.anchorNode,
          sel.focusNode,
          sel.isCollapsed,
          window.location.href
        );
        if (href && e.clipboardData && e.clipboardData.setData) {
          e.clipboardData.setData("text/plain", href);
          e.preventDefault();
          if (typeof e.stopImmediatePropagation === "function") {
            e.stopImmediatePropagation();
          }
        }
      } catch (err) {
        /* fall through: default copy behavior */
      }
    },
    true
  );

  window.addEventListener(
    "keydown",
    function (e) {
      try {
        var mod = e.ctrlKey || e.metaKey;
        if (!mod || e.altKey || e.shiftKey) return;
        if (e.key !== "c" && e.key !== "C") return;
        var sel = window.getSelection ? window.getSelection() : null;
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        var href = copyHrefForSelection(
          sel.anchorNode,
          sel.focusNode,
          false,
          window.location.href
        );
        var clip =
          window.navigator && window.navigator.clipboard
            ? window.navigator.clipboard
            : null;
        if (!href || !clip || typeof clip.writeText !== "function") return;
        e.preventDefault();
        if (typeof e.stopImmediatePropagation === "function") {
          e.stopImmediatePropagation();
        }
        clip.writeText(href);
      } catch (err) {
        /* fall through: default key handling */
      }
    },
    true
  );

  // MCD-ISSUE-1-V3: bubble-phase copy listener. Runs LAST, after every page
  // handler: if the clipboard ended up holding a bare markdown link while
  // the selected text was something else (the rendered card text), replace
  // it with just the URL. If the user selected raw markdown source, the
  // selection text equals the clipboard text and we leave it alone.
  window.addEventListener(
    "copy",
    function (e) {
      try {
        var cd = e.clipboardData;
        if (!cd || typeof cd.getData !== "function") return;
        if (typeof cd.setData !== "function") return;
        var cur = cd.getData("text/plain");
        if (!cur) return;
        var url = mdLinkToUrl(cur);
        if (url === cur) return;
        var sel = selectionText();
        if (sel && sel.trim() === cur.trim()) return;
        cd.setData("text/plain", url);
      } catch (err) {
        /* getData may throw; leave the clipboard alone */
      }
    },
    false
  );
})();
