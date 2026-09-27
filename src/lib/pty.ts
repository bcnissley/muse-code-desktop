import { invoke } from "@tauri-apps/api/core";

export interface PtyEvent {
  kind: "output" | "exit";
  text: string;
}

/** Manage one interactive PTY session via the Rust backend. */
export class PtyClient {
  private id: string;
  private listeners = new Set<(e: PtyEvent) => void>();
  private outUnlisten: (() => void) | null = null;
  private exitUnlisten: (() => void) | null = null;
  private dead = false;

  constructor(id: string) {
    this.id = id;
  }

  async spawn(shell: string, cols: number, rows: number, cwd: string): Promise<void> {
    if (this.dead) throw new Error("pty closed");
    await invoke("pty_spawn", { id: this.id, shell, cols, rows, cwd });
    const { listen } = await import("@tauri-apps/api/event");
    this.outUnlisten = await listen<string>(`pty-output-${this.id}`, (ev) => {
      this.emit({ kind: "output", text: ev.payload });
    });
    this.exitUnlisten = await listen(`pty-exit-${this.id}`, () => {
      this.emit({ kind: "exit", text: "" });
    });
  }

  private emit(e: PtyEvent) {
    for (const l of this.listeners) l(e);
  }

  onEvent(cb: (e: PtyEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  write(data: string): Promise<void> {
    if (this.dead) return Promise.resolve();
    return invoke("pty_write", { id: this.id, data });
  }

  resize(cols: number, rows: number): Promise<void> {
    if (this.dead) return Promise.resolve();
    return invoke("pty_resize", { id: this.id, cols, rows });
  }

  async close(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    this.outUnlisten?.();
    this.exitUnlisten?.();
    this.listeners.clear();
    try {
      await invoke("pty_kill", { id: this.id });
    } catch {
      /* already gone */
    }
  }
}

export async function defaultShell(): Promise<string> {
  return invoke<string>("default_shell");
}

export async function ptyRunOnce(
  command: string,
  cwd: string,
  shell: string
): Promise<string> {
  return invoke<string>("pty_run_once", { command, cwd, shell });
}
