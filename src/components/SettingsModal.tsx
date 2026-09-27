import { useEffect, useState } from "react";
import type { CliConfig } from "./Workspace";
import { ptyRunOnce, defaultShell } from "../lib/pty";
import { setMuseUrl, type MusePanelStatus } from "../lib/panel";
import { appVersion } from "../lib/version";
import { DEFAULT_MUSE_URL, MUSE_MODEL } from "../constants";

export default function SettingsModal({
  config,
  panel,
  voiceHotkey,
  onVoiceHotkey,
  onSave,
  onClose,
}: {
  config: CliConfig;
  panel: MusePanelStatus | null;
  voiceHotkey: boolean;
  onVoiceHotkey: (v: boolean) => void;
  onSave: (c: CliConfig) => void;
  onClose: () => void;
}) {
  const [command, setCommand] = useState(config.command);
  const [args, setArgs] = useState(config.args);
  const [autoStart, setAutoStart] = useState(config.autoStart);
  const [museUrl, setMuseUrlState] = useState(DEFAULT_MUSE_URL);
  const [checkOut, setCheckOut] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [ver, setVer] = useState("");
  useEffect(() => {
    appVersion().then(setVer).catch(() => {});
  }, []);

  const save = () => {
    onSave({
      command: command.trim() || "muse",
      args: args.trim(),
      autoStart,
    });
    onClose();
  };

  const applyMuseUrl = async () => {
    try {
      await setMuseUrl(museUrl.trim() || DEFAULT_MUSE_URL);
    } catch (e) {
      setCheckOut(`Muse URL error: ${String(e)}`);
    }
  };

  // Honest check: verify the executable exists and echo the launch line.
  // We do NOT invent CLI flags — the model name shown in the UI is
  // informational until the real CLI's own help is consulted.
  const verifyCli = async () => {
    setChecking(true);
    setCheckOut("Checking…");
    try {
      const shell = await defaultShell();
      const whichCmd = shell.toLowerCase().includes("powershell")
        ? `where.exe ${command.trim() || "muse"}`
        : `command -v ${command.trim() || "muse"}`;
      const out = await ptyRunOnce(whichCmd, ".", shell);
      const found = out.trim().length > 0;
      const launch = `${command.trim() || "muse"} ${args.trim()}`.trim();
      setCheckOut(
        found
          ? `Found executable:\n${out.trim()}\n\nLaunch line: "${launch}"\nSubscription auth happens in the CLI itself — start it and follow its login flow.`
          : `Could not find "${command.trim() || "muse"}" on PATH.\nInstall the Muse Code CLI and make sure it's on your PATH, then start it from the terminal drawer.`
      );
    } catch (e) {
      setCheckOut(`Check failed: ${String(e)}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>

        <div className="field">
          <label>MUSE CODE CLI</label>
          <div className="field-row">
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="muse"
              spellCheck={false}
            />
          </div>
          <div className="note">
            Executable launched inside the embedded terminal. The UI reports the
            model as <b>{MUSE_MODEL}</b>; this is informational — confirm the
            CLI's real model flags from its own help/docs.
          </div>
        </div>

        <div className="field">
          <label>CLI ARGUMENTS</label>
          <input
            type="text"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="(none)"
            spellCheck={false}
          />
          <div className="note">
            Extra arguments appended to the launch line. Left blank by default
            so the CLI's native flow (including subscription login) runs
            untouched.
          </div>
        </div>

        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
            />
            Start the CLI automatically on launch
          </label>
        </div>

        <div className="field">
          <label className="check">
            <input
              type="checkbox"
              checked={voiceHotkey}
              onChange={(e) => onVoiceHotkey(e.target.checked)}
            />
            Voice hotkey (F9) — toggles dictation on/off
          </label>
          <div className="note">
            Works anywhere in the app. Tap the mic button to dictate, hold it to talk.
          </div>
        </div>

        <div className="field">
          <label>MUSE PANEL URL</label>
          <div className="field-row">
            <input
              type="text"
              value={museUrl}
              onChange={(e) => setMuseUrlState(e.target.value)}
              placeholder={DEFAULT_MUSE_URL}
              spellCheck={false}
            />
            <button className="btn" onClick={applyMuseUrl} style={{ flexShrink: 0 }}>
              Apply
            </button>
          </div>
          <div className="note">
            {panel?.available
              ? panel.visible
                ? "The Muse side panel is active."
                : "The Muse side panel is hidden — toggle it from the top bar."
              : "Side-by-side panel not available on this machine (single-window mode)."}
          </div>
        </div>

        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          <button className="btn" onClick={verifyCli} disabled={checking}>
            {checking ? "Checking…" : "Verify CLI"}
          </button>
        </div>
        {checkOut && <div className="status-out">{checkOut}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
        {ver && <div className="ver-line">Muse Code Desktop v{ver}</div>}
      </div>
    </div>
  );
}
