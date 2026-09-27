# Muse Code Desktop

A real Windows desktop app that hosts **Muse Code** — chat-style workspace,
embedded terminal running the actual Muse Code CLI, tool timeline, voice
input, and a side-by-side **Muse** (`muse.ai`) panel. Dark mode only, obsidian
black, black-hole logo.

Built with [Tauri 2](https://tauri.app) + React + xterm.js.

## What it does

- **Muse Code workspace**: chat composer on top, terminal drawer below.
  Chat runs **headless** — each prompt goes through `muse exec --json
  --session-id <uuid>` (one shared session per run) and the JSONL text
  events stream into clean chat bubbles. No terminal scraping.
- **Embedded PTY**: the drawer still runs the full interactive CLI in a
  real pseudoterminal (Rust `portable-pty`), so interactive prompts,
  colors, and auth flows behave exactly like a normal terminal. Hide it
  entirely with **Hide terminal** in the tab row (bring it back with
  **Show terminal** in the same spot) to give chat the full height.
- **Subscription auth**: the CLI's own login flow runs inside the embedded
  terminal — sign in there with your normal subscription. The UI reports the
  model as `muse-spark-1.3-contributor` (informational — verify the CLI's
  real model flags from its own help/docs; the launch command and args are
  configurable in Settings).
- **Side-by-side Muse panel**: `muse.ai` in a second webview, drag-to-resize
  split, toggle from the top bar, persistent session.
- **Links never escape**: any link clicked anywhere in the app — Muse Code
  workspace, Muse panel, terminal output, in-app browser windows — opens in
  the app's **internal** browser windows. Never in Edge/Chrome/the OS
  browser. Enforced in Rust (`on_new_window` denies native popups), a
  capture-phase JS interceptor injected into every webview at
  `document_start`, and the xterm link provider.
- **Voice input**: tap the mic to dictate, hold to talk until you release
  (Web Speech API; clearly disabled where unsupported).
- **Tool timeline**: a running log of CLI output and your prompts.

## Prerequisites (Windows)

1. **Node.js 20+** (LTS) — https://nodejs.org
2. **Rust toolchain** — https://rustup.rs (install the MSVC build tools when prompted)
3. **WebView2** — ships with Windows 10/11, nothing to do.
4. **The Muse Code CLI** on your PATH as `muse` (or set your own command in
   Settings). Verify with **Settings → Verify CLI**.

## Run it (dev)

```powershell
cd muse-code-desktop
npm install
npm run tauri dev
```

That's it. `npm run dev` runs the frontend only (no PTY, no Muse panel —
those need the Tauri shell); `npm run tauri dev` is the real thing.

## Project layout

```
muse-code-desktop/
├── src/                    # React frontend
│   ├── App.tsx             # shell: sidebar, topbar, split handle
│   ├── components/
│   │   ├── Workspace.tsx   # chat + timeline tabs + terminal drawer
│   │   ├── Composer.tsx    # prompt box + voice mic
│   │   ├── TerminalPane.tsx# xterm.js rendering the PTY
│   │   └── SettingsModal.tsx # CLI command/args, Muse URL, Verify CLI
│   ├── lib/pty.ts          # Tauri invoke wrapper for PTY sessions
│   ├── lib/exec.ts         # Tauri invoke wrapper for headless exec runs + JSONL text extraction
│   ├── lib/panel.ts        # Muse panel + in-app browser commands
│   └── lib/voice.ts        # Web Speech dictation helpers
├── src-tauri/
│   ├── src/main.rs         # setup: multi-webview window or fallback
│   ├── src/pty.rs          # PTY manager (spawn/write/resize/kill/run-once)
│   ├── src/exec.rs         # headless exec manager (spawn/kill, JSONL event pump)
│   ├── src/panel.rs        # Muse child webview, split, browser windows
│   ├── src/link-interceptor.js # capture-phase link router (all webviews)
│   └── src/tests.rs        # link-contract tests (`cargo test`)
├── assets/                 # logo masters (SVG + PNG)
└── docs/                   # ARCHITECTURE.md, TEST-PLAN.md
```

## Packaging

The installer is deliberately **not built yet** — dev-run first, package
later. When you're ready:

```powershell
npm run tauri build
```

Note: Tauri expects the full icon set in `src-tauri/icons/` before
`tauri build` (128x128.png, 128x128@2x.png, etc.). Generate them with
`npx tauri icon assets/logo-1024.png` before packaging.

## Honest caveats

- Rust code has **not been compiled** in this workspace (no Rust toolchain
  on the Linux build box). First Windows run may surface small compile
  issues — fix them there, they're the real target.
- The Muse Code CLI's exact invocation flags were not verified against a
  real CLI binary. Settings leaves the launch line minimal and configurable
  on purpose.
- Web Speech dictation depends on the WebView2 speech backend; where it's
  unsupported the mic button disables itself with an explanation.

## Project Spaces

The left sidebar lists project spaces — each one is a working folder used as
the cwd for both headless chat (`muse exec`) and the interactive terminal.

- **+** creates a space: pick a parent folder, name it, and the folder is
  created on disk (`projects::project_create_dir`).
- Drag spaces to re-order them; order and list persist in localStorage.
- Hover a space for ✎ (rename — renames the folder on disk too) and ×
  (removes it from the list; the folder stays).
- The terminal drawer can be hidden from the tab row ("Hide terminal") so the
  chat gets the full height; starting the CLI re-opens it.
- **Hide Muse Code** (top bar) collapses the entire Muse Code side — chat,
  tabs, and terminal — leaving Muse AI with the full window. A slim strip
  on the left brings it back. Handy for sharing the app with someone who
  only uses Muse AI.
