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
  const window: Record<string, any> = {};
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
