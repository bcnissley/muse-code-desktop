import { useCallback, useEffect, useRef, useState } from "react";
import Composer from "./Composer";
import TerminalPane from "./TerminalPane";
import { LOGO_URL, MUSE_MODEL } from "../constants";
import { PtyClient, defaultShell } from "../lib/pty";
import { ExecClient, extractExecText, isExecNoise } from "../lib/exec";

export interface CliConfig {
  command: string; // e.g. "muse"
  args: string; // extra args appended when launching the interactive drawer
  autoStart: boolean;
}

interface Message {
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
}

interface TimelineEvent {
  ts: number;
  text: string;
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function newSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      return crypto.randomUUID();
  } catch {
    /* fall through to manual fallback */
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Muse Code workspace: chat composer on top, terminal drawer below.
 *
 * Chat runs headless: each prompt goes through `muse exec --json
 * --session-id <uuid>` (one shared session id per app run) and the JSONL
 * text events stream into clean chat bubbles — no terminal scraping.
 * The drawer below still hosts the full interactive CLI in a real PTY
 * for sign-in/auth flows and hands-on terminal work.
 */
export default function Workspace({
  config,
  cwd,
}: {
  config: CliConfig;
  cwd: string;
}) {
  const [tab, setTab] = useState<"chat" | "timeline">("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [drawerHidden, setDrawerHidden] = useState(true);
  const [drawerHeight, setDrawerHeight] = useState(220);
  const [busy, setBusy] = useState(false);
  const [execBusy, setExecBusy] = useState(false);
  const [telemetry, setTelemetry] = useState<string[]>([]);
  const ptyRef = useRef<PtyClient | null>(null);
  const execRef = useRef<ExecClient | null>(null);
  const execTextRef = useRef("");
  const sessionIdRef = useRef("");
  const msgsEndRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const telemetryRef = useRef<HTMLDivElement>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const logTimeline = useCallback((text: string) => {
    setTimeline((t) => [...t.slice(-400), { ts: Date.now(), text }]);
  }, []);

  const pushTelemetry = useCallback((label: string) => {
    setTelemetry((t) => [...t.slice(-29), label]);
  }, []);

  // Keep the ticker pinned to the newest event.
  useEffect(() => {
    const el = telemetryRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [telemetry]);

  const lastAssistantRef = useRef<{ idx: number; ts: number } | null>(null);

  const pushMessage = useCallback((role: Message["role"], text: string) => {
    setMessages((m) => [...m, { role, text, ts: Date.now() }]);
  }, []);

  /** Set the current assistant bubble's text (creates it if needed). */
  const setAssistantText = useCallback((text: string) => {
    setMessages((m) => {
      const last = lastAssistantRef.current;
      if (last && m[last.idx]?.role === "assistant") {
        const copy = m.slice();
        copy[last.idx] = { ...copy[last.idx], text, ts: Date.now() };
        return copy;
      }
      lastAssistantRef.current = { idx: m.length, ts: Date.now() };
      return [...m, { role: "assistant" as const, text, ts: Date.now() }];
    });
  }, []);

  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const startCli = useCallback(async () => {
    if (busy || running) return;
    setBusy(true);
    try {
      if (!sessionIdRef.current) sessionIdRef.current = newSessionId();
      const pty = new PtyClient(`muse-${Date.now()}`);
      const shell = await defaultShell();
      const cols = 140;
      const rows = 30;
      await pty.spawn(shell, cols, rows, cwdRef.current || ".");
      pty.onEvent((e) => {
        if (e.kind === "output") {
          logTimeline(`[cli] ${stripAnsi(e.text).slice(0, 120)}`);
        } else {
          pushMessage("system", "CLI process exited.");
          logTimeline("[cli] process exited");
          setRunning(false);
          ptyRef.current = null;
        }
      });
      const cfg = configRef.current;
      const launch = `${cfg.command} ${cfg.args}`.trim();
      pty.write(`${launch}\r`);
      ptyRef.current = pty;
      setRunning(true);
      pushMessage(
        "system",
        `Launched "${launch}" in the embedded terminal. Chat above runs headless — no need to wait for this.`
      );
      logTimeline(`launched: ${launch}`);
    } catch (err) {
      pushMessage("system", `Failed to start CLI: ${String(err)}`);
      logTimeline(`start failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, running, logTimeline, pushMessage]);

  const stopCli = useCallback(async () => {
    const pty = ptyRef.current;
    ptyRef.current = null;
    setRunning(false);
    if (pty) {
      await pty.close();
      pushMessage("system", "CLI session closed.");
      logTimeline("session closed");
    }
  }, [pushMessage, logTimeline]);

  useEffect(() => {
    if (config.autoStart && !running && !busy && !ptyRef.current) {
      startCli();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.autoStart]);

  const sendPrompt = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || execBusy) return;
      const cmd = configRef.current.command.trim() || "muse";
      if (!sessionIdRef.current) sessionIdRef.current = newSessionId();
      const sessionId = sessionIdRef.current;
      // Headless exec: clean JSONL on stdout, one shared session id so
      // prompts keep context across turns. cwd matches the PTY spawn (".").
      const args = [
        "exec",
        "--json",
        "--session-id",
        sessionId,
        "--model",
        MUSE_MODEL,
        "--",
        t,
      ];
      const exec = new ExecClient(`exec-${Date.now()}`);
      execRef.current = exec;
      execTextRef.current = "";
      lastAssistantRef.current = null; // new prompt → new assistant bubble
      pushMessage("user", t);
      setAssistantText("Thinking…");
      setExecBusy(true);
      pushTelemetry("◌ thinking");
      logTimeline(`[you] ${t.slice(0, 120)}`);
      logTimeline(`[exec] ${cmd} exec --json --session-id ${sessionId.slice(0, 8)}…`);
      exec.onEvent((e) => {
        if (e.kind === "output") {
          // CLI internal logs -> timeline only, never the bubble.
          if (isExecNoise(e.text)) {
            logTimeline(`[exec] ${e.text.trim().slice(0, 140)}`);
            return;
          }
          const { text: chunk, tool, event } = extractExecText(e.text);
          if (tool) {
            logTimeline(`[tool] ${tool}`);
            pushTelemetry(`⚙ ${tool}`);
            return;
          }
          if (event) pushTelemetry(event);
          if (chunk) {
            execTextRef.current += chunk;
            setAssistantText(execTextRef.current);
          }
        } else {
          const code = e.code ?? -1;
          logTimeline(`[exec] exited (code ${code})`);
          pushTelemetry(code === 0 ? "✓ done" : `✗ exit ${code}`);
          if (code !== 0 && !execTextRef.current) {
            setAssistantText(
              `Muse Code exited with code ${code} before answering. See the Tool timeline for details.`
            );
          }
          setExecBusy(false);
          if (execRef.current === exec) execRef.current = null;
        }
      });
      try {
        await exec.start(cmd, args, cwdRef.current || ".");
      } catch (err) {
        pushMessage("system", `Exec failed to start: ${String(err)}`);
        logTimeline(`exec start failed: ${String(err)}`);
        setExecBusy(false);
        execRef.current = null;
      }
    },
    [execBusy, pushMessage, logTimeline, pushTelemetry, setAssistantText]
  );

  const stopExec = useCallback(async () => {
    const exec = execRef.current;
    execRef.current = null;
    setExecBusy(false);
    if (exec) {
      await exec.kill();
      pushMessage("system", "Exec stopped.");
      logTimeline("[exec] stopped by user");
    }
  }, [pushMessage, logTimeline]);

  // Drawer resize drag
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const col = document.querySelector(".main-col");
      if (!col) return;
      const rect = col.getBoundingClientRect();
      const h = Math.max(80, Math.min(rect.height * 0.7, rect.bottom - e.clientY));
      setDrawerHeight(h);
    };
    const onUp = () => (draggingRef.current = false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div className="chat-pane">
      <div className="tabs">
        <button
          className={`tab ${tab === "chat" ? "active" : ""}`}
          onClick={() => setTab("chat")}
        >
          Chat
        </button>
        <button
          className={`tab ${tab === "timeline" ? "active" : ""}`}
          onClick={() => setTab("timeline")}
        >
          Tool timeline
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="icon-btn"
          onClick={() => setDrawerHidden((h) => !h)}
          title={drawerHidden ? "Show the terminal drawer" : "Hide the terminal drawer"}
        >
          {drawerHidden ? "▸ Show terminal" : "❚❚ Hide terminal"}
        </button>
        <span className="pill model" title="Model the Muse Code CLI is set to use">
          {MUSE_MODEL}
        </span>
      </div>

      {tab === "chat" ? (
        <>
          <div className="messages">
            {messages.length === 0 ? (
              <div className="launch-hero">
                <img src={LOGO_URL} alt="Muse Code Desktop" />
                <h2>Muse Code, minus the terminal window</h2>
                <p>
                  Chat here runs headless via <code>muse exec</code> — just
                  type below, no terminal needed. The drawer hosts the full
                  interactive CLI for sign-in and hands-on work.
                </p>
                <button className="big-btn" onClick={startCli} disabled={busy}>
                  {busy ? "Starting…" : "Start Muse Code"}
                </button>
              </div>
            ) : (
              <>
                {messages.map((m, i) => (
                  <div
                    key={i}
                    className={`msg ${m.role}${m.role === "assistant" && execBusy && m.text === "Thinking…" ? " thinking" : ""}`}
                  >
                    <span className="role">
                      {m.role === "user"
                        ? "YOU"
                        : m.role === "assistant"
                          ? "MUSE CODE"
                          : "SYSTEM"}{" "}
                      · {fmtTs(m.ts)}
                    </span>
                    {m.role === "assistant" && execBusy && m.text === "Thinking…" ? (
                      <span className="thinking-dots">
                        Thinking<span className="dots" aria-hidden="true" />
                      </span>
                    ) : (
                      m.text
                    )}
                  </div>
                ))}
                <div ref={msgsEndRef} />
              </>
            )}
          </div>
          {telemetry.length > 0 && (
            <div
              ref={telemetryRef}
              className="telemetry"
              title="Live exec activity"
            >
              {telemetry.map((label, i) => (
                <span key={i} className="telemetry-chip">
                  {label}
                </span>
              ))}
            </div>
          )}
          <Composer
            onSend={sendPrompt}
            onStop={stopExec}
            disabled={execBusy}
            working={execBusy}
          />
        </>
      ) : (
        <div className="timeline">
          {timeline.length === 0 ? (
            <div style={{ color: "var(--faint)", padding: "16px" }}>
              Nothing yet — CLI output and actions land here as they happen.
            </div>
          ) : (
            timeline.map((t, i) => (
              <div key={i} className="tl-row">
                <span className="ts">{fmtTs(t.ts)}</span>
                <span className="tx">{t.text}</span>
              </div>
            ))
          )}
        </div>
      )}

      {!drawerHidden && (
        <div className="drawer" style={{ height: drawerHeight }}>
          <div
            className="drawer-bar"
            onMouseDown={() => (draggingRef.current = true)}
            title="Drag to resize"
          >
            <span>Terminal — Muse Code CLI</span>
            <div style={{ flex: 1 }} />
            {running ? (
              <button className="icon-btn" onClick={stopCli}>
                Stop CLI
              </button>
            ) : (
              <button className="icon-btn gold" onClick={startCli} disabled={busy}>
                {busy ? "Starting…" : "Start CLI"}
              </button>
            )}
          </div>
          {ptyRef.current && (
            <TerminalPane pty={ptyRef.current} height={drawerHeight} />
          )}
          {!ptyRef.current && (
            <div
              style={{
                padding: "18px",
                color: "var(--faint)",
                fontSize: "12px",
                textAlign: "center",
              }}
            >
              No active CLI session — hit <b>Start CLI</b> above.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\r/g, "")
    .trim();
}
