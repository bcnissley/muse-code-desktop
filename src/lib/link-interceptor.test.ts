import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(here, "../../src-tauri/src/link-interceptor.js"),
  "utf8"
);

function loadDecide() {
  const clicks: Array<{ type: string; capture: boolean }> = [];
  // v2 registers copy/keydown listeners on window (capture phase).
  const window: Record<string, any> = {
    addEventListener: (type: string, _fn: unknown, capture?: boolean) =>
      clicks.push({ type, capture: !!capture }),
  };
  const document = {
    addEventListener: (type: string, _fn: unknown, capture: boolean) =>
      clicks.push({ type, capture }),
  };
  runInNewContext(src, { window, document, URL });
  return {
    decide: window.__mcdRouteDecision as (
      href: string,
      pageHref: string,
      target: string,
      mods: boolean
    ) => string,
    copyHref: window.__mcdCopyHref as (
      anchorNode: unknown,
      focusNode: unknown,
      isCollapsed: boolean,
      pageHref: string
    ) => string | null,
    clicks,
  };
}

const PAGE = "https://muse.ai/chat";

describe("link-interceptor routing contract", () => {
  it("installs a capture-phase click listener", () => {
    const { clicks } = loadDecide();
    expect(clicks).toContainEqual({ type: "click", capture: true });
  });

  it("lets same-origin same-tab links navigate natively", () => {
    const { decide } = loadDecide();
    expect(decide("/settings", PAGE, "", false)).toBe("allow");
    expect(decide("https://muse.ai/pricing", PAGE, "", false)).toBe("allow");
  });

  it("routes cross-origin links to the in-app browser", () => {
    const { decide } = loadDecide();
    expect(decide("https://github.com", PAGE, "", false)).toBe("in-app");
    expect(decide("https://example.com/a?b=c", PAGE, "", false)).toBe("in-app");
  });

  it("routes target=_blank and modifier/middle clicks in-app", () => {
    const { decide } = loadDecide();
    expect(decide("https://muse.ai/x", PAGE, "_blank", false)).toBe("in-app");
    expect(decide("https://muse.ai/x", PAGE, "", true)).toBe("in-app");
  });

  it("ignores fragments, javascript:, and non-http schemes", () => {
    const { decide } = loadDecide();
    expect(decide("#section", PAGE, "", false)).toBe("ignore");
    expect(decide("javascript:void(0)", PAGE, "", false)).toBe("ignore");
    expect(decide("mailto:a@b.com", PAGE, "", false)).toBe("ignore");
    // A relative garbage string resolves same-origin in a real browser too,
    // so the interceptor correctly leaves it to the webview.
    expect(decide("not a url %%", PAGE, "", false)).toBe("allow");
    expect(decide("http://[invalid", PAGE, "", false)).toBe("ignore");
  });

  it("never references an external-browser surface", () => {
    expect(src).not.toContain("window.open(");
    expect(src).not.toContain("shell.open");
  });
});

// MCD-COPY-V2-TEST: the page serializes selections to markdown via machinery
// a document-level listener could not preempt (v1's stopImmediatePropagation
// still lost -- verified with a plain-text address-bar paste). v2 listens on
// window in the capture phase and also intercepts Ctrl/Cmd+C at keydown for
// pages that copy through the async clipboard API.
describe("copy handler v2: window capture + keydown interception", () => {
  type FakeEl = {
    nodeType: number;
    parentElement?: FakeEl | null;
    getAttribute: (name: string) => string | null;
    closest: (sel: string) => FakeEl | null;
  };
  type Listener = {
    target: "window" | "document";
    type: string;
    fn: (e: any) => void;
    capture: boolean;
  };

  const TEST_URL = "https://example.com/copy-test-12345";
  const TEST_MD = "[copy-test-link](https://example.com/copy-test-12345)";

  function loadHarness(collapsed = false) {
    const listeners: Listener[] = [];
    const anchor: FakeEl = {
      nodeType: 1,
      getAttribute: (name: string) => (name === "href" ? TEST_URL : null),
      closest: (sel: string) => (sel === "a[href]" ? anchor : null),
    };
    const textNode: FakeEl = {
      nodeType: 3,
      parentElement: anchor,
      getAttribute: () => null,
      closest: () => null,
    };
    const clipboardWrites: string[] = [];
    const fakeWindow: Record<string, any> = {
      location: { href: PAGE },
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: collapsed,
        anchorNode: textNode,
        focusNode: textNode,
      }),
      navigator: {
        clipboard: {
          writeText: (t: string) => {
            clipboardWrites.push(t);
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
    return { fakeWindow, listeners, clipboardWrites };
  }

  // Browser-faithful dispatch: capture listeners run before bubble ones;
  // registration order within the same target+phase.
  function dispatch(listeners: Listener[], type: string, event: any) {
    const matching = listeners.filter((l) => l.type === type);
    const ordered = [
      ...matching.filter((l) => l.capture),
      ...matching.filter((l) => !l.capture),
    ];
    for (const l of ordered) {
      if (event._stopped) break;
      l.fn(event);
    }
  }

  function fakeCopyEvent() {
    const store: Record<string, string> = {};
    const event: any = {
      clipboardData: {
        setData: (k: string, v: string) => {
          store[k] = v;
        },
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

  function fakeKeydown() {
    const event: any = {
      key: "c",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {
        event._prevented = true;
      },
      stopImmediatePropagation: () => {
        event._stopped = true;
      },
    };
    return event;
  }

  it("__mcdCopyHref resolves the anchor URL for a link-only selection", () => {
    const { fakeWindow } = loadHarness();
    const sel = fakeWindow.getSelection();
    expect(
      fakeWindow.__mcdCopyHref(
        sel.anchorNode,
        sel.focusNode,
        sel.isCollapsed,
        PAGE
      )
    ).toBe(TEST_URL);
  });

  it("registers the copy listener on window in the capture phase", () => {
    const { listeners } = loadHarness();
    expect(
      listeners.filter(
        (l) => l.target === "window" && l.type === "copy" && l.capture
      )
    ).toHaveLength(1);
  });

  it("keeps the URL when a later copy handler tries to overwrite it", () => {
    const { listeners } = loadHarness();
    // The page's own serializer, registered after ours (e.g. a React onCopy
    // on document, bubble phase).
    let hostileRan = false;
    listeners.push({
      target: "document",
      type: "copy",
      capture: false,
      fn: (e: any) => {
        hostileRan = true;
        e.clipboardData.setData("text/plain", TEST_MD);
      },
    });
    const { event, store } = fakeCopyEvent();
    dispatch(listeners, "copy", event);
    expect(event._stopped).toBe(true);
    expect(hostileRan).toBe(false);
    expect(store["text/plain"]).toBe(TEST_URL);
  });

  it("intercepts Ctrl+C at keydown and writes the URL via the async clipboard", () => {
    const { listeners, clipboardWrites } = loadHarness();
    const event = fakeKeydown();
    dispatch(listeners, "keydown", event);
    expect(event._prevented).toBe(true);
    expect(event._stopped).toBe(true);
    expect(clipboardWrites).toEqual([TEST_URL]);
  });

  it("leaves keydown alone when the selection is collapsed", () => {
    const { listeners, clipboardWrites } = loadHarness(true);
    const event = fakeKeydown();
    dispatch(listeners, "keydown", event);
    expect(event._prevented).not.toBe(true);
    expect(event._stopped).not.toBe(true);
    expect(clipboardWrites).toEqual([]);
  });
});


describe("link-interceptor copy behavior (issue #1)", () => {
  function anchor(href: string) {
    const el: Record<string, any> = {
      nodeType: 1,
      getAttribute: (name: string) => (name === "href" ? href : null),
    };
    el.closest = (sel: string) => (sel === "a[href]" ? el : null);
    return el;
  }
  const textIn = (parent: unknown) => ({ nodeType: 3, parentElement: parent });

  it("copies the URL when the selection sits inside a single link", () => {
    const { copyHref } = loadDecide();
    const a = anchor("/connect/gmail");
    const t = textIn(a);
    expect(copyHref(t, t, false, PAGE)).toBe("https://muse.ai/connect/gmail");
  });

  it("keeps default copy for collapsed or multi-anchor selections", () => {
    const { copyHref } = loadDecide();
    const a = anchor("https://example.com/x");
    const b = anchor("https://example.com/y");
    const t = textIn(a);
    expect(copyHref(t, t, true, PAGE)).toBeNull();
    expect(copyHref(textIn(a), textIn(b), false, PAGE)).toBeNull();
    expect(
      copyHref(textIn(a), { nodeType: 3, parentElement: null }, false, PAGE)
    ).toBeNull();
  });

  it("resolves absolute hrefs unchanged", () => {
    const { copyHref } = loadDecide();
    const a = anchor("https://example.com/abs");
    expect(copyHref(textIn(a), textIn(a), false, PAGE)).toBe(
      "https://example.com/abs"
    );
  });
});

// MCD-COPY-V3-TEST: the chat renders links as rich unfurl cards, not <a>
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
