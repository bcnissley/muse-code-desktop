# Test plan

## Automated

### Frontend — `npm run build`
Runs `tsc --noEmit` then `vite build`. Catches type errors in all
components, lib modules, and Tauri invoke signatures. **Passing.**

### JS tests — `npm test` (vitest)
`src/lib/link-interceptor.test.ts` — 6 tests against the real
`src-tauri/src/link-interceptor.js`, loaded in a VM sandbox:
- capture-phase click listener is installed
- same-origin same-tab links navigate natively ("allow")
- cross-origin links route in-app ("in-app")
- `target=_blank` and modifier/middle clicks route in-app
- fragments / `javascript:` / `mailto:` / unparsable URLs are ignored
- no external-browser surface (`window.open(`, `shell.open`) in the script

**Passing (6/6).**

### Rust — `cargo test` (in src-tauri/)
`src/tests.rs` covers the link contract:
- `link_interceptor` (6 tests): capture-phase click listener exists,
  external/new-window links route through `open_in_app_browser`,
  no `window.open` / `shell.open` / external-browser surface anywhere,
  only http/https intercepted, browser windows override `window.open`,
  idempotent install.
- `panel_contract` (3 tests): interceptor script non-empty, mic permission
  allowlisted for microphone only, panel defaults keep an https Muse URL.

**Not yet run to completion:** a Rust toolchain was installed on the Linux
build box (Sep 27, 2026), `Cargo.toml` resolves cleanly, but compiling the
Tauri dependency needs GTK/WebKit system libraries (`gdk-3.0` etc.) that
are not installed and cannot be installed here (no sudo). Run `cargo test`
on the Windows machine, where WebView2 is the backend and no such
system packages are needed.

## Manual (Windows machine, the real target)

1. `npm install`, then `npm run tauri dev`.
2. **Muse panel**: the muse.ai webview appears right of the workspace.
   Drag the split handle — the Muse view follows. Toggle it from the top
   bar — it hides/shows. Reload keeps you logged in (persistent data dir).
3. **Links never escape**: click any link in the Muse panel or terminal
   output. It must open a "browser-N" window inside the app, never Edge/
   Chrome. `window.open` popups do the same. Verify NO external browser
   process spawns.
4. **CLI**: hit "Start Muse Code". The CLI's own login flow appears in the
   drawer; complete subscription auth there. Type in the composer — the
   prompt lands in the CLI. Type directly in the drawer — same thing.
5. **Voice**: click the mic (tap = toggle dictation, hold = talk until
   release). In an unsupported environment the button is disabled with an
   explanation.
6. **Settings → Verify CLI**: confirms the `muse` executable is on PATH
   and echoes the launch line. Model shown in the UI is
   `muse-spark-1.3-contributor` (informational until the CLI's own
   help/docs confirm its real model flags).

## Known gaps (honest)

- Rust compilation was NOT verified here (see above). First Windows run
  should expect to fix small compile issues in src-tauri before the app
  boots; the code was reviewed against current Tauri 2 docs instead.
- The exact Muse Code CLI invocation flags were not verified against a real
  CLI binary. The default launch line is configurable in Settings and left
  minimal on purpose.
- Web Speech dictation depends on the WebView2 speech backend; where it's
  unsupported the mic button disables itself with an explanation.
