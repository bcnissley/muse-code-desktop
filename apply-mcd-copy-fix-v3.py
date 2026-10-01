#!/usr/bin/env python3
"""v3 fix for muse-code-desktop issue #1 (copy markdown link -> URL).

v2 lost because the chat renders links as rich unfurl CARDS, not <a>
elements -- there is no anchor for the DOM detection to find, so the
handlers never fired. But the page's copy machinery always outputs the
same shape: a bare markdown link "[text](url)".

v3 catches it at the clipboard level instead of the DOM level:
  1. Helpers: mdLinkToUrl() spots a bare "[text](url)" string and returns
     just the URL; selectionText() reads the current selection.
  2. navigator.clipboard.writeText is wrapped (installed at document_start,
     so the page always gets the wrapped version): a bare markdown link
     becomes just the URL. Covers keydown + async-clipboard copies, which
     never fire a copy event.
  3. A window BUBBLE-phase copy listener runs LAST, after every page
     handler: if the clipboard ended up holding a bare markdown link while
     the selected text was something else (the rendered card text), it is
     replaced with just the URL.
  Safety discriminator (both paths): if the selected text EQUALS the
  clipboard text, the user copied raw markdown source (e.g. from a code
  block) and it passes through untouched. Plain text is never matched by
  the regex, so normal copies are unaffected.

Usage: save as apply-mcd-copy-fix-v3.py in the repo root
(C:\\Users\\Brian\\muse-code-desktop\\) and run:
    python apply-mcd-copy-fix-v3.py
Then rebuild:  npx tauri build   (link-interceptor.js is baked in via include_str!)
Idempotent: re-running skips already-applied hunks.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if not (ROOT / "src-tauri" / "tauri.conf.json").exists():
    sys.exit("FAIL: run this script from the muse-code-desktop repo root.")

HELPERS_JS = '''  // MCD-ISSUE-1-V3 helpers: the chat renders links as rich unfurl cards
  // rather than <a> elements, so anchor detection can't find them. Whatever
  // the page's copy machinery is, its output is unmistakable: a bare
  // markdown link "[text](url)". Detect that shape at the clipboard level
  // and keep only the URL.
  function mdLinkToUrl(t) {
    if (typeof t !== "string") return t;
    var m = /^\\[([^\\]]*)\\]\\((https?:\\/\\/[^)\\s]+)\\)$/.exec(t);
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

'''

BUBBLE_JS = '''
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
})();\n'''

V3_TEST = '''// MCD-COPY-V3-TEST: the chat renders links as rich unfurl cards, not <a>
// elements, so anchor detection can't fire. v3 catches the page's output
// instead: a bare markdown link "[text](url)" on the clipboard (or via the
// async clipboard API) becomes just the URL -- unless the user selected raw
// markdown source, which passes through untouched.
describe("copy handler v3: clipboard-level markdown transform", () => {
  type V3FakeEl = {
    nodeType: number;
    parentElement?: V3FakeEl | null;
    getAttribute: (name: string) => string | null;
    closest: (sel: string) => V3FakeEl | null;
  };
  type V3Listener = {
    target: "window" | "document";
    type: string;
    fn: (e: any) => void;
    capture: boolean;
  };

  const TEST_URL = "https://example.com/copy-test-12345";
  const TEST_MD = "[copy-test-link](https://example.com/copy-test-12345)";

  // Selection inside a rich unfurl card: no anchor anywhere in the path.
  function loadCardHarness(selText: string) {
    const listeners: V3Listener[] = [];
    const card: V3FakeEl = {
      nodeType: 1,
      getAttribute: () => null,
      closest: () => null,
    };
    const textNode: V3FakeEl = {
      nodeType: 3,
      parentElement: card,
      getAttribute: () => null,
      closest: () => null,
    };
    const rawWrites: string[] = [];
    const fakeWindow: Record<string, any> = {
      location: { href: PAGE },
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: false,
        anchorNode: textNode,
        focusNode: textNode,
        toString: () => selText,
      }),
      navigator: {
        clipboard: {
          writeText: (t: string) => {
            rawWrites.push(String(t));
            return Promise.resolve();
          },
        },
      },
      addEventListener: (
        type: string,
        fn: (e: any) => void,
        capture?: boolean
      ) => {
        listeners.push({ target: "window", type, fn, capture: !!capture });
      },
    };
    const fakeDocument = {
      addEventListener: (
        type: string,
        fn: (e: any) => void,
        capture?: boolean
      ) => {
        listeners.push({ target: "document", type, fn, capture: !!capture });
      },
    };
    runInNewContext(src, { window: fakeWindow, document: fakeDocument, URL });
    return { fakeWindow, listeners, rawWrites };
  }

  // Full DOM event flow: capture window->document, then bubble document->window.
  function dispatchFull(listeners: V3Listener[], type: string, event: any) {
    const groups: V3Listener[][] = [
      listeners.filter(
        (l) => l.type === type && l.capture && l.target === "window"
      ),
      listeners.filter(
        (l) => l.type === type && l.capture && l.target === "document"
      ),
      listeners.filter(
        (l) => l.type === type && !l.capture && l.target === "document"
      ),
      listeners.filter(
        (l) => l.type === type && !l.capture && l.target === "window"
      ),
    ];
    for (const group of groups) {
      for (const l of group) {
        if (event._stopped) break;
        l.fn(event);
      }
      if (event._stopped) break;
    }
  }

  function fakeCopyEventRW() {
    const store: Record<string, string> = {};
    const event: any = {
      clipboardData: {
        setData: (k: string, v: string) => {
          store[k] = v;
        },
        getData: (k: string) => store[k] || "",
      },
      preventDefault: () => {
        event._prevented = true;
      },
      stopImmediatePropagation: () => {
        event._stopped = true;
      },
    };
    return { event, store };
  }

  function hostileSerializer(listeners: V3Listener[]) {
    // The page's copy machinery: document bubble, registered after ours.
    listeners.push({
      target: "document",
      type: "copy",
      capture: false,
      fn: (e: any) => {
        e.clipboardData.setData("text/plain", TEST_MD);
      },
    });
  }

  it("turns a card copy's markdown into the URL (copy-event path)", () => {
    const { listeners } = loadCardHarness("copy-test-link");
    hostileSerializer(listeners);
    const { event, store } = fakeCopyEventRW();
    dispatchFull(listeners, "copy", event);
    expect(store["text/plain"]).toBe(TEST_URL);
  });

  it("leaves raw markdown source copies alone", () => {
    const { listeners } = loadCardHarness(TEST_MD);
    hostileSerializer(listeners);
    const { event, store } = fakeCopyEventRW();
    dispatchFull(listeners, "copy", event);
    expect(store["text/plain"]).toBe(TEST_MD);
  });

  it("leaves plain-text copies alone", () => {
    const { listeners } = loadCardHarness("just some text");
    listeners.push({
      target: "document",
      type: "copy",
      capture: false,
      fn: (e: any) => {
        e.clipboardData.setData("text/plain", "just some text");
      },
    });
    const { event, store } = fakeCopyEventRW();
    dispatchFull(listeners, "copy", event);
    expect(store["text/plain"]).toBe("just some text");
  });

  it("writeText wrapper turns a bare markdown link into the URL", () => {
    const { fakeWindow, rawWrites } = loadCardHarness("copy-test-link");
    fakeWindow.navigator.clipboard.writeText(TEST_MD);
    expect(rawWrites).toEqual([TEST_URL]);
  });

  it("writeText wrapper passes normal text through", () => {
    const { fakeWindow, rawWrites } = loadCardHarness("copy-test-link");
    fakeWindow.navigator.clipboard.writeText("hello world");
    expect(rawWrites).toEqual(["hello world"]);
  });

  it("writeText wrapper leaves raw markdown selections alone", () => {
    const { fakeWindow, rawWrites } = loadCardHarness(TEST_MD);
    fakeWindow.navigator.clipboard.writeText(TEST_MD);
    expect(rawWrites).toEqual([TEST_MD]);
  });
});
'''

applied, skipped = [], []

# ---- 1. helpers + writeText wrapper, inserted before the v2 Issue #1 block ----
js = ROOT / "src-tauri/src/link-interceptor.js"
jssrc = js.read_text(encoding="utf-8")
if "MCD-ISSUE-1-V3" in jssrc:
    skipped.append("copy handler v3 helpers (already applied)")
else:
    marker = "  // Issue #1: selecting a rendered markdown link"
    idx = jssrc.find(marker)
    if idx < 0:
        sys.exit("FAIL [copy v3]: v2 block anchor not found; run apply-mcd-copy-fix-v2.py first")
    jssrc = jssrc[:idx] + HELPERS_JS + jssrc[idx:]
    applied.append("copy handler v3 helpers + writeText wrapper")

# ---- 2. bubble-phase copy listener before the final })(); ----
if "MCD-ISSUE-1-V3: bubble-phase" in jssrc:
    skipped.append("copy handler v3 bubble listener (already applied)")
else:
    tail_marker = "/* fall through: default key handling */"
    idx = jssrc.find(tail_marker)
    if idx < 0:
        sys.exit("FAIL [copy v3]: v2 keydown block anchor not found")
    end_seq = "  );\n})();"
    end_idx = jssrc.find(end_seq, idx)
    if end_idx < 0 or jssrc[end_idx + len(end_seq):].strip() != "":
        sys.exit("FAIL [copy v3]: v2 keydown block is not at EOF as expected")
    jssrc = jssrc[:end_idx] + "  );\n" + BUBBLE_JS
    applied.append("copy handler v3 bubble listener")

js.write_text(jssrc, encoding="utf-8")

# ---- 3. vitest: append the v3 suite ----
ts = ROOT / "src/lib/link-interceptor.test.ts"
tssrc = ts.read_text(encoding="utf-8")
if "MCD-COPY-V3-TEST" in tssrc:
    skipped.append("vitest: copy v3 suite (already applied)")
else:
    if not tssrc.endswith("\n"):
        tssrc += "\n"
    tssrc += "\n" + V3_TEST
    ts.write_text(tssrc, encoding="utf-8")
    applied.append("vitest: copy v3 suite")

print(f"\napplied: {len(applied)}, skipped: {len(skipped)}")
for s in skipped:
    print(f"  SKIP {s}")
for a in applied:
    print(f"  OK   {a}")
