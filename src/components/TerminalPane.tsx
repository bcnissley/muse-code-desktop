import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { openInAppBrowser } from "../lib/panel";
import type { PtyClient } from "../lib/pty";

/**
 * Terminal drawer with xterm. Clicked links are routed to the app's
 * internal browser — never the OS browser.
 */
export default function TerminalPane({
  pty,
  height,
}: {
  pty: PtyClient;
  height: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cols: 120,
      rows: Math.max(4, Math.floor(height / 18)),
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#000000",
        foreground: "#e8eaed",
        cursor: "#f0bd3d",
        selectionBackground: "rgba(240, 189, 61, 0.25)",
        black: "#000000",
        red: "#e5484d",
        green: "#46c46a",
        yellow: "#f0bd3d",
        blue: "#4c9be8",
        magenta: "#c792ea",
        cyan: "#4cd0e0",
        white: "#e8eaed",
        brightBlack: "#3a4150",
        brightRed: "#ff6b6b",
        brightGreen: "#7ee787",
        brightYellow: "#ffd76a",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#76e3ea",
        brightWhite: "#ffffff",
      },
      fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
      fontSize: 12.5,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    const off = pty.onEvent((e) => {
      if (e.kind === "output") term.write(e.text);
      else term.writeln("\r\n[process exited]");
    });

    term.onData((d) => pty.write(d));
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (ev.key === "Enter" || ev.key === "Escape" || ev.key.startsWith("Arrow"))
        return true;
      return !ev.ctrlKey && !ev.metaKey;
    });

    // Linkify: click routes into the internal browser.
    term.registerLinkProvider({
      provideLinks: (y: number, cb: (links: any[]) => void) => {
        const line = term.buffer.active.getLine(y);
        if (!line) return cb([]);
        const text = line.translateToString(true);
        const re = /https?:\/\/[^\s<>"')\]]+/g;
        const links: any[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          links.push({
            range: {
              start: { x: m.index + 1, y },
              end: { x: m.index + m[0].length + 1, y },
            },
            activate: (_ev: any, url: string) => {
              openInAppBrowser(url).catch(() => {});
            },
            text: m[0],
            tooltip: "Open in Muse Code browser",
          });
        }
        cb(links);
      },
    });

    fit.fit();
    term.focus();

    // The webview can be resized by the host (split drag, panel toggle)
    // before layout settles — re-fit on the next frames to converge.
    let raf = 0;
    const refit = () => {
      try {
        fit.fit();
        pty.resize(term.cols, term.rows);
      } catch {
        /* not ready */
      }
    };
    const kick = () => {
      raf = requestAnimationFrame(() => {
        refit();
        setTimeout(refit, 120);
      });
    };
    kick();

    const ro = new ResizeObserver(() => {
      refit();
    });
    ro.observe(host);
    window.addEventListener("resize", refit);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", refit);
      ro.disconnect();
      off();
      term.dispose();
      termRef.current = null;
    };
  }, [pty]);

  useEffect(() => {
    const t = termRef.current;
    if (t) {
      const host = hostRef.current;
      if (host) host.style.height = `${Math.max(40, height - 32)}px`;
    }
  }, [height]);

  return (
    <div className="drawer-term" style={{ height: `${height}px` }}>
      <div ref={hostRef} style={{ height: "100%", width: "100%" }} />
    </div>
  );
}
