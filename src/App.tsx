import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import Workspace, { type CliConfig } from "./components/Workspace";
import SettingsModal from "./components/SettingsModal";
import Splash from "./components/Splash";
import GitHubSection from "./components/GitHubSection";
import { gitInfo, type GitInfo } from "./lib/git";
import { LOGO_URL, DEFAULT_PROJECTS } from "./constants";
import {
  loadSpaces,
  saveSpaces,
  newSpaceId,
  sanitizeSpaceName,
  type ProjectSpace,
} from "./lib/spaces";
import {
  musePanelStatus,
  setMusePanel,
  setMuseCodePanel,
  setMuseSplit,
  openInAppBrowser,
  type MusePanelStatus,
} from "./lib/panel";
import { appVersion } from "./lib/version";

const CFG_KEY = "mcd.cli-config";
const CODE_HIDDEN_KEY = "mcd.code-hidden";
const VOICE_HOTKEY_KEY = "mcd.voice-hotkey";

function loadConfig(): CliConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        command: typeof p.command === "string" ? p.command : "muse",
        args: typeof p.args === "string" ? p.args : "",
        autoStart: p.autoStart === true,
      };
    }
  } catch {
    /* fall through */
  }
  return { command: "muse", args: "", autoStart: false };
}

export default function App() {
  const [config, setConfig] = useState<CliConfig>(loadConfig);
  const [panel, setPanel] = useState<MusePanelStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [spaces, setSpaces] = useState<ProjectSpace[]>(() =>
    loadSpaces(DEFAULT_PROJECTS)
  );
  const [activeId, setActiveId] = useState<string>("");
  const [codeHidden, setCodeHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CODE_HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [gitInfos, setGitInfos] = useState<Record<string, GitInfo>>({});
  const [appVer, setAppVer] = useState("");
  const [voiceHotkey, setVoiceHotkey] = useState<boolean>(() => {
    try {
      return localStorage.getItem(VOICE_HOTKEY_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const dragRef = useRef(false);
  // Live-drag state lives outside React: the webviews are repositioned
  // natively by Rust, so no re-render is needed until the gesture ends.
  // NOTE: window.innerWidth here is the app-view webview's width, NOT the
  // OS window width — so the drag is computed as a delta from the grab
  // point against the window width derived at grab time. This keeps the
  // math stable while the webview resizes under the cursor.
  const dragBaseRef = useRef(0.6); // split fraction at grab time
  const dragX0Ref = useRef(0); // clientX at grab time
  const dragWinWRef = useRef(1200); // estimated full window width at grab
  const dragRatioRef = useRef(0.6); // live ratio during the gesture
  const dragRafRef = useRef(0);
  const spaceDragIdx = useRef<number | null>(null);

  const activeSpace = spaces.find((s) => s.id === activeId) ?? spaces[0];

  useEffect(() => {
    saveSpaces(spaces);
    if (!activeId && spaces.length > 0) setActiveId(spaces[0].id);
  }, [spaces, activeId]);

  useEffect(() => {
    appVersion().then(setAppVer).catch(() => {});
  }, []);

  // F9 toggles voice dictation anywhere in the app (unless disabled in settings).
  useEffect(() => {
    if (!voiceHotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F9") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("mcd:toggle-voice"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voiceHotkey]);

  const setVoiceHotkeyPersisted = useCallback((v: boolean) => {
    setVoiceHotkey(v);
    try {
      localStorage.setItem(VOICE_HOTKEY_KEY, v ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, []);

  // Git status per space (branch + dirty). Failures mean "not a repo".
  const refreshGit = useCallback(() => {
    spaces.forEach((s) => {
      gitInfo(s.path)
        .then((gi) =>
          setGitInfos((m) => (m[s.id]?.is_repo === gi.is_repo && m[s.id]?.branch === gi.branch && m[s.id]?.dirty === gi.dirty && m[s.id]?.changed === gi.changed ? m : { ...m, [s.id]: gi }))
        )
        .catch(() =>
          setGitInfos((m) => ({
            ...m,
            [s.id]: { is_repo: false, branch: null, dirty: false, changed: 0, remote: null, owner_repo: null },
          }))
        );
    });
  }, [spaces]);

  useEffect(() => {
    refreshGit();
  }, [refreshGit]);

  const addSpace = useCallback((name: string, path: string) => {
    const space: ProjectSpace = { id: newSpaceId(), name, path };
    setSpaces((s) => [...s, space]);
    setActiveId(space.id);
  }, []);

  const createSpace = useCallback(async () => {
    try {
      const parent = await open({ directory: true, multiple: false, title: "Choose where to create the project space" });
      if (!parent || typeof parent !== "string") return;
      const raw = window.prompt("Name your new project space:");
      if (!raw) return;
      const name = sanitizeSpaceName(raw);
      if (!name) {
        window.alert("That name won't work as a folder — try another.");
        return;
      }
      const fullPath = `${parent.replace(/[/\\]$/, "")}/${name}`;
      await invoke<string>("project_create_dir", { path: fullPath });
      const space: ProjectSpace = { id: newSpaceId(), name, path: fullPath };
      setSpaces((s) => [...s, space]);
      setActiveId(space.id);
    } catch (err) {
      window.alert(`Couldn't create the space: ${String(err)}`);
    }
  }, []);

  const removeSpace = useCallback(    (id: string) => {
      setSpaces((s) => {
        if (s.length <= 1) {
          window.alert("You need at least one project space.");
          return s;
        }
        const next = s.filter((sp) => sp.id !== id);
        if (id === activeId) setActiveId(next[0].id);
        return next;
      });
    },
    [activeId]
  );

  const renameSpace = useCallback(
    async (id: string) => {
      const space = spaces.find((s) => s.id === id);
      if (!space) return;
      const raw = window.prompt(
        "Rename project space (renames the folder on disk too):",
        space.name
      );
      if (raw == null) return;
      const name = sanitizeSpaceName(raw);
      if (!name) {
        window.alert("That name won't work as a folder — try another.");
        return;
      }
      if (name === space.name) return;
      const sep = space.path.includes("\\") ? "\\" : "/";
      const idx = space.path.lastIndexOf(sep);
      const parent = idx > 0 ? space.path.slice(0, idx) : space.path;
      const newPath = `${parent}${sep}${name}`;
      try {
        const finalPath = await invoke<string>("project_rename_dir", {
          old_path: space.path,
          new_path: newPath,
        });
        setSpaces((s) =>
          s.map((sp) => (sp.id === id ? { ...sp, name, path: finalPath } : sp))
        );
      } catch (err) {
        window.alert(`Couldn't rename the space: ${String(err)}`);
      }
    },
    [spaces]
  );

  const moveSpace = useCallback((from: number, to: number) => {
    setSpaces((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.length || to >= s.length) return s;
      const next = [...s];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  useEffect(() => {
    musePanelStatus()
      .then((s) => {
        setPanel(s);
        // Restore the user's last Muse Code visibility choice.
        let hidden = false;
        try {
          hidden = localStorage.getItem(CODE_HIDDEN_KEY) === "1";
        } catch {
          /* ignore */
        }
        if (hidden && s.code_visible && s.available) {
          setMuseCodePanel(false)
            .then(setPanel)
            .catch(() => {});
        }
        setCodeHidden(hidden && s.available);
      })
      .catch(() =>
        setPanel({ available: false, visible: false, split: 0.6, code_visible: true })
      );
  }, []);

  const togglePanel = useCallback(async () => {
    try {
      const next = await setMusePanel(!(panel?.visible ?? true));
      setPanel(next);
    } catch {
      /* non-fatal */
    }
  }, [panel]);

  const toggleCodePanel = useCallback(async () => {
    try {
      const next = await setMuseCodePanel(codeHidden);
      setPanel(next);
      const hidden = !next.code_visible;
      setCodeHidden(hidden);
      try {
        localStorage.setItem(CODE_HIDDEN_KEY, hidden ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
    } catch {
      /* non-fatal */
    }
  }, [codeHidden]);

  const saveConfig = useCallback((c: CliConfig) => {
    setConfig(c);
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(c));
    } catch {
      /* storage unavailable */
    }
  }, []);

  // Split drag: the handle between the Muse Code side and the Muse panel.
  // Butter-smooth by design: mousemove only records the target ratio and
  // schedules one native reposition per animation frame. React state (and
  // its re-render cascade) is touched exactly once, on release.
  const onDragMove = useCallback((e: MouseEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragX0Ref.current;
    const winW = dragWinWRef.current || 1200;
    dragRatioRef.current = Math.min(0.8, Math.max(0.25, dragBaseRef.current + dx / winW));
    if (!dragRafRef.current) {
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = 0;
        if (dragRef.current) setMuseSplit(dragRatioRef.current).catch(() => {});
      });
    }
  }, []);
  const onDragEnd = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = false;
    if (dragRafRef.current) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = 0;
    }
    document.querySelector(".split-handle")?.classList.remove("dragging");
    // One authoritative sync: native position + React state + persisted value.
    setMuseSplit(dragRatioRef.current)
      .then(setPanel)
      .catch(() => {});
  }, []);
  useEffect(() => {
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
    return () => {
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragEnd);
    };
  }, [onDragMove, onDragEnd]);

  // Muse Code side collapsed: slim strip with a restore affordance.
  // The Rust side shrinks this webview to 60px and gives Muse the rest.
  if (codeHidden) {
    return (
      <div className="app-shell">
        <div className="code-strip">
          <button
            className="code-strip-btn"
            onClick={toggleCodePanel}
            title="Show the Muse Code side"
          >
            <span className="code-strip-icon">▶</span>
            <span className="code-strip-label">MUSE CODE</span>
          </button>
        </div>
        {settingsOpen && (
          <SettingsModal
            config={config}
            panel={panel}
            voiceHotkey={voiceHotkey}
            onVoiceHotkey={setVoiceHotkeyPersisted}
            onSave={saveConfig}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Splash />
      <aside className="sidebar">
        <div className="brand">
          <img src={LOGO_URL} alt="Muse Code" />
          <div className="wordmark">
            MUSE CODE<small>desktop</small>
          </div>
        </div>

        <div className="side-label-row">
          <div className="side-label">PROJECT SPACES</div>
          <button
            className="side-add"
            onClick={createSpace}
            title="Create a new project space (new folder)"
          >
            +
          </button>
        </div>
        {spaces.map((p, i) => (
          <div
            key={p.id}
            className={`proj ${activeSpace?.id === p.id ? "active" : ""}`}
            onClick={() => setActiveId(p.id)}
            title={p.path}
            draggable
            onDragStart={(e) => {
              spaceDragIdx.current = i;
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = spaceDragIdx.current;
              spaceDragIdx.current = null;
              if (from != null) moveSpace(from, i);
            }}
          >
            <span className="dot" />
            <span className="proj-name">{p.name}</span>
            {gitInfos[p.id]?.is_repo && (
              <span
                className="git-badge"
                title={`⎇ ${gitInfos[p.id].branch ?? "HEAD"}${gitInfos[p.id].dirty ? ` — ${gitInfos[p.id].changed} changed` : " — clean"}`}
              >
                ⎇ {gitInfos[p.id].branch ?? "HEAD"}
                {gitInfos[p.id].dirty && <span className="dirty-dot" />}
              </span>
            )}
            <button
              className="proj-rename"
              title="Rename space (renames the folder)"
              onClick={(e) => {
                e.stopPropagation();
                renameSpace(p.id);
              }}
            >
              ✎
            </button>
            <button
              className="proj-x"
              title="Remove from list (keeps the folder)"
              onClick={(e) => {
                e.stopPropagation();
                removeSpace(p.id);
              }}
            >
              ×
            </button>
          </div>
        ))}

        <div style={{ flex: 1 }} />

        <GitHubSection
          activeSpace={activeSpace ?? null}
          activeGit={activeSpace ? gitInfos[activeSpace.id] ?? null : null}
          onChanged={refreshGit}
          onAddSpace={addSpace}
        />

        <div className="side-foot">
          <button
            className={`side-btn ${panel?.visible ? "active" : ""}`}
            onClick={togglePanel}
            disabled={!panel?.available}
            title={
              panel?.available
                ? "Toggle the Muse side panel"
                : "Side panel not available on this machine"
            }
          >
            {panel?.visible ? "❚❚" : "▶"} Muse panel
          </button>
          <button
            className="side-btn"
            onClick={() =>
              openInAppBrowser("https://muse.ai").catch(() => {})
            }
            title="Open the Muse assistant in the in-app browser"
          >
            ↗ Open Muse in browser
          </button>
          <button className="side-btn" onClick={() => setSettingsOpen(true)}>
            ⚙ Settings
          </button>
        </div>
      </aside>

      <div className="main-col">
        <div className="topbar">
          <span className="title">{activeSpace?.name ?? "Muse Code"}</span>
          <span className="pill">
            <span className="live-dot" />
            CLI workspace
          </span>
          {appVer && <span className="pill">v{appVer}</span>}
          <div className="spacer" />
          <button
            className="icon-btn"
            onClick={toggleCodePanel}
            disabled={!panel?.available}
            title={
              panel?.available
                ? "Collapse the Muse Code side — Muse AI takes the full window"
                : "Side-by-side mode not available on this machine"
            }
          >
            Hide Muse Code
          </button>
          {panel?.available ? (
            <button className="icon-btn" onClick={togglePanel}>
              {panel.visible ? "Hide Muse panel" : "Show Muse panel"}
            </button>
          ) : (
            <span className="pill">single-window mode</span>
          )}
        </div>

        <div className="workspace">
          <Workspace config={config} cwd={activeSpace?.path ?? "."} />
          {panel?.available && panel.visible && (
            <div
              className="split-handle"
              title="Drag to resize the Muse panel"
              onMouseDown={(e) => {
                e.preventDefault();
                dragRef.current = true;
                dragX0Ref.current = e.clientX;
                const viewW = window.innerWidth;
                setPanel((p) => {
                  if (p && p.split > 0) {
                    dragBaseRef.current = p.split;
                    dragRatioRef.current = p.split;
                    // app-view width == split * window width while dragging.
                    dragWinWRef.current = viewW / p.split;
                  }
                  return p;
                });
                e.currentTarget.classList.add("dragging");
              }}
            />
          )}
        </div>
      </div>

      {settingsOpen && (
        <SettingsModal
          config={config}
          panel={panel}
          voiceHotkey={voiceHotkey}
          onVoiceHotkey={setVoiceHotkeyPersisted}
          onSave={saveConfig}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
