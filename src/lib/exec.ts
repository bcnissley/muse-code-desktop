import { invoke } from "@tauri-apps/api/core";

export interface ExecEvent {
  kind: "output" | "exit";
  text: string;
  code?: number;
}

/** Manage one headless `muse exec --json` run via the Rust backend. */
export class ExecClient {
  private id: string;
  private listeners = new Set<(e: ExecEvent) => void>();
  private outUnlisten: (() => void) | null = null;
  private exitUnlisten: (() => void) | null = null;
  private dead = false;

  constructor(id: string) {
    this.id = id;
  }

  async start(command: string, args: string[], cwd: string): Promise<void> {
    if (this.dead) throw new Error("exec closed");
    // Register listeners BEFORE spawning so no early output is missed.
    const { listen } = await import("@tauri-apps/api/event");
    this.outUnlisten = await listen<string>(`exec-output-${this.id}`, (ev) => {
      this.emit({ kind: "output", text: ev.payload });
    });
    this.exitUnlisten = await listen<number>(`exec-exit-${this.id}`, (ev) => {
      this.emit({ kind: "exit", text: "", code: ev.payload });
    });
    await invoke("exec_start", { id: this.id, command, args, cwd });
  }

  private emit(e: ExecEvent) {
    for (const l of this.listeners) l(e);
  }

  onEvent(cb: (e: ExecEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async kill(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    this.outUnlisten?.();
    this.exitUnlisten?.();
    this.listeners.clear();
    try {
      await invoke("exec_kill", { id: this.id });
    } catch {
      /* already gone */
    }
  }
}

/** Object keys whose string values are human-readable answer text. */
const TEXT_KEYS = new Set([
  "text",
  "delta",
  "content",
  "message",
  "output",
  "answer",
  "result",
  "response",
  "data",
]);

function collectText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      if (TEXT_KEYS.has(k.toLowerCase())) {
        if (typeof v === "string") {
          if (v) out.push(v);
        } else {
          collectText(v, out);
        }
      } else {
        collectText(v, out);
      }
    }
  }
}

/** Heuristic: does this JSON value look like a tool-call event? */
function detectToolName(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null || Array.isArray(node))
    return undefined;
  const o = node as Record<string, unknown>;
  const typeStr = typeof o.type === "string" ? o.type.toLowerCase() : "";
  if (!typeStr.includes("tool")) return undefined;
  const name = o.tool ?? o.tool_name ?? o.name;
  return typeof name === "string" && name ? name : undefined;
}

/**
 * Pull displayable text out of one `muse exec --json` JSONL line.
 * Defensive by design: unknown shapes degrade to plain text, tool-call
 * events are reported separately so they never pollute the chat bubble.
 */
export function extractExecText(line: string): { text: string; tool?: string; event?: string } {
  const trimmed = line.trim();
  if (!trimmed) return { text: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { text: trimmed }; // not JSON — plain text line
  }
  if (typeof parsed === "string") return { text: parsed };
  const tool = detectToolName(parsed);
  if (tool) return { text: "", tool, event: "tool" };
  const event = eventLabel(parsed);
  const parts: string[] = [];
  collectText(parsed, parts);
  return { text: parts.join(""), event };
}

/** Best-effort human label for a JSONL event (its type/kind), for telemetry. */
function eventLabel(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  for (const k of ["type", "event", "kind"]) {
    const val = o[k];
    if (typeof val === "string" && val.trim()) return val.trim().slice(0, 40);
  }
  return undefined;
}

/**
 * CLI internal log chatter that must never reach the chat bubble
 * (e.g. "muse: workspace root: …", "opening meta model stream attempt 1/10").
 * These go to the timeline instead.
 */
const NOISE_RE = /^(muse\s*:|opening meta model|completed meta model|.*\bmodel stream attempt\b)/i;

export function isExecNoise(line: string): boolean {
  return NOISE_RE.test(line.trim());
}
