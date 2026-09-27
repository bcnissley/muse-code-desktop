import { useCallback, useEffect, useState } from "react";
import { openInAppBrowser } from "../lib/panel";
import {
  ghAvailable,
  ghAuthStatus,
  ghAuthLoginToken,
  ghRepoList,
  ghClone,
  ghRepoCreate,
  gitCommit,
  gitBranches,
  gitBranchCreate,
  gitBranchSwitch,
  gitPush,
  gitPull,
  ghFork,
  type GhAuth,
  type GitInfo,
  type Repo,
} from "../lib/git";
import type { ProjectSpace } from "../lib/spaces";

type Modal = null | "connect" | "clone" | "commit" | "branch" | "newrepo" | "fork";

interface Props {
  activeSpace: ProjectSpace | null;
  activeGit: GitInfo | null;
  onChanged: () => void;
  onAddSpace: (name: string, path: string) => void;
}

function parentOf(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/";
  const idx = p.lastIndexOf(sep);
  return idx > 0 ? p.slice(0, idx) : p;
}

function fail(err: unknown, what: string) {
  const msg = String(err);
  window.alert(`${what} failed: ${msg.replace(/^Error:\s*/, "")}`);
}

export default function GitHubSection({ activeSpace, activeGit, onChanged, onAddSpace }: Props) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [auth, setAuth] = useState<GhAuth | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoFilter, setRepoFilter] = useState("");
  const [branches, setBranches] = useState<string[] | null>(null);

  const [token, setToken] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [repoName, setRepoName] = useState("");
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [forkRef, setForkRef] = useState("");

  const refreshAuth = useCallback(async () => {
    try {
      const ok = await ghAvailable();
      setAvailable(ok);
      if (ok) setAuth(await ghAuthStatus());
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  const openModal = useCallback(
    (m: Exclude<Modal, null>) => {
      setRepoFilter("");
      setCommitMsg("");
      setNewBranch("");
      setForkRef(activeGit?.owner_repo ?? "");
      setRepoName(activeSpace?.name ?? "");
      if (m === "clone") {
        setRepos(null);
        ghRepoList().then(setRepos).catch((e) => fail(e, "Loading repos"));
      }
      if (m === "branch" && activeSpace) {
        setBranches(null);
        gitBranches(activeSpace.path)
          .then(setBranches)
          .catch((e) => fail(e, "Loading branches"));
      }
      setModal(m);
    },
    [activeSpace, activeGit]
  );

  const runBusy = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      fail(e, key);
    } finally {
      setBusy(null);
    }
  }, []);

  const doConnect = () =>
    runBusy("Connect", async () => {
      const user = await ghAuthLoginToken(token);
      setToken("");
      setModal(null);
      await refreshAuth();
      window.alert(`Connected as @${user}`);
    });

  const doClone = (repo: Repo) =>
    runBusy(`clone:${repo.full_name}`, async () => {
      if (!activeSpace) return;
      const dest = await ghClone(repo.full_name, parentOf(activeSpace.path));
      const name = repo.full_name.split("/")[1];
      setModal(null);
      onAddSpace(name, dest);
    });

  const doCommit = () =>
    runBusy("Commit", async () => {
      if (!activeSpace) return;
      const hash = await gitCommit(activeSpace.path, commitMsg);
      setModal(null);
      onChanged();
      window.alert(`Committed ${hash}`);
    });

  const doPush = () =>
    runBusy("Push", async () => {
      if (!activeSpace) return;
      const out = await gitPush(activeSpace.path);
      onChanged();
      window.alert(out);
    });

  const doPull = () =>
    runBusy("Pull", async () => {
      if (!activeSpace) return;
      const out = await gitPull(activeSpace.path);
      onChanged();
      window.alert(out);
    });

  const doBranchSwitch = (b: string) =>
    runBusy(`switch:${b}`, async () => {
      if (!activeSpace) return;
      await gitBranchSwitch(activeSpace.path, b);
      setModal(null);
      onChanged();
    });

  const doBranchCreate = () =>
    runBusy("Create branch", async () => {
      if (!activeSpace) return;
      await gitBranchCreate(activeSpace.path, newBranch);
      setModal(null);
      onChanged();
    });

  const doNewRepo = () =>
    runBusy("Create repo", async () => {
      if (!activeSpace) return;
      const url = await ghRepoCreate(activeSpace.path, repoName, repoPrivate);
      setModal(null);
      onChanged();
      window.alert(`Repo created and pushed:\n${url}`);
    });

  const doFork = () =>
    runBusy("Fork", async () => {
      if (!activeSpace) return;
      const dest = await ghFork(forkRef, parentOf(activeSpace.path));
      const name = forkRef.split("/")[1];
      setModal(null);
      onAddSpace(name, dest);
    });

  const filtered = repos?.filter((r) =>
    r.full_name.toLowerCase().includes(repoFilter.toLowerCase())
  );

  return (
    <>
      <div className="side-label-row">
        <div className="side-label">GITHUB</div>
      </div>
      <div className="gh-box">
        {available === null ? (
          <div className="gh-muted">Checking for the gh CLI…</div>
        ) : !available ? (
          <div className="gh-muted">
            gh CLI not found.{" "}
            <button
              className="gh-link"
              onClick={() => openInAppBrowser("https://cli.github.com").catch(() => {})}
            >
              Install it
            </button>{" "}
            then restart the app.
          </div>
        ) : !auth?.logged_in ? (
          <button className="side-btn" onClick={() => openModal("connect")}>
            Connect GitHub
          </button>
        ) : (
          <>
            <div className="gh-user">@{auth.user ?? "connected"}</div>
            {activeSpace && (
              <div className="gh-space">
                <div className="gh-space-name" title={activeSpace.path}>
                  {activeSpace.name}
                </div>
                {activeGit?.is_repo ? (
                  <div className="gh-gitline">
                    <span className="git-badge">⎇ {activeGit.branch ?? "HEAD"}</span>
                    {activeGit.dirty && (
                      <span className="git-dirty">● {activeGit.changed} changed</span>
                    )}
                  </div>
                ) : (
                  <div className="gh-muted">Not a git repo</div>
                )}
                <div className="gh-actions">
                  {activeGit?.is_repo ? (
                    <>
                      <button className="gh-btn" disabled={!!busy} onClick={() => openModal("commit")}>
                        Commit
                      </button>
                      <button className="gh-btn" disabled={!!busy} onClick={doPush}>
                        {busy === "Push" ? "…" : "Push"}
                      </button>
                      <button className="gh-btn" disabled={!!busy} onClick={doPull}>
                        {busy === "Pull" ? "…" : "Pull"}
                      </button>
                      <button className="gh-btn" disabled={!!busy} onClick={() => openModal("branch")}>
                        Branch
                      </button>
                    </>
                  ) : (
                    <button className="gh-btn wide" disabled={!!busy} onClick={() => openModal("newrepo")}>
                      Save to new repo
                    </button>
                  )}
                  <button className="gh-btn" disabled={!!busy} onClick={() => openModal("clone")}>
                    Clone
                  </button>
                  <button className="gh-btn" disabled={!!busy} onClick={() => openModal("fork")}>
                    Fork
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {modal === "connect" && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Connect GitHub</h3>
            <div className="field">
              <label>PERSONAL ACCESS TOKEN (CLASSIC, `repo` SCOPE)</label>
              <input
                type="text"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_…"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="note">
                The token goes straight to the gh CLI — the app never stores it.{" "}
                <button
                  className="gh-link"
                  onClick={() =>
                    openInAppBrowser("https://github.com/settings/tokens/new").catch(() => {})
                  }
                >
                  Create one on github.com
                </button>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn primary" disabled={!!busy || !token.trim()} onClick={doConnect}>
                {busy === "Connect" ? "Connecting…" : "Connect"}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === "clone" && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Clone a repo</h3>
            <div className="field">
              <input
                type="text"
                value={repoFilter}
                onChange={(e) => setRepoFilter(e.target.value)}
                placeholder="Filter repos…"
                spellCheck={false}
              />
            </div>
            <div className="repo-list">
              {!repos ? (
                <div className="gh-muted">Loading…</div>
              ) : filtered?.length === 0 ? (
                <div className="gh-muted">No repos match.</div>
              ) : (
                filtered?.map((r) => (
                  <div key={r.full_name} className="repo-row">
                    <span className="repo-name" title={r.full_name}>
                      {r.private ? "🔒 " : ""}{r.full_name}
                    </span>
                    <button
                      className="gh-btn"
                      disabled={!!busy}
                      onClick={() => doClone(r)}
                    >
                      {busy === `clone:${r.full_name}` ? "…" : "Clone"}
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {modal === "commit" && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Commit — {activeSpace?.name}</h3>
            <div className="field">
              <label>MESSAGE</label>
              <input
                type="text"
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                placeholder="What changed?"
                spellCheck={false}
                onKeyDown={(e) => e.key === "Enter" && commitMsg.trim() && doCommit()}
              />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn primary" disabled={!!busy || !commitMsg.trim()} onClick={doCommit}>
                {busy === "Commit" ? "Committing…" : "Commit"}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === "branch" && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Branches — {activeSpace?.name}</h3>
            <div className="repo-list">
              {!branches ? (
                <div className="gh-muted">Loading…</div>
              ) : (
                branches.map((b) => (
                  <div key={b} className="repo-row">
                    <span className="repo-name">⎇ {b}</span>
                    {b === activeGit?.branch ? (
                      <span className="gh-muted">current</span>
                    ) : (
                      <button className="gh-btn" disabled={!!busy} onClick={() => doBranchSwitch(b)}>
                        Switch
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label>NEW BRANCH</label>
              <div className="field-row">
                <input
                  type="text"
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  placeholder="feature/thing"
                  spellCheck={false}
                />
                <button className="btn" disabled={!!busy || !newBranch.trim()} onClick={doBranchCreate}>
                  Create
                </button>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {modal === "newrepo" && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Save to a new repo — {activeSpace?.name}</h3>
            <div className="field">
              <label>REPO NAME</label>
              <input
                type="text"
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                spellCheck={false}
              />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={repoPrivate}
                onChange={(e) => setRepoPrivate(e.target.checked)}
              />
              Private repo
            </label>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn primary" disabled={!!busy || !repoName.trim()} onClick={doNewRepo}>
                {busy === "Create repo" ? "Creating…" : "Create & push"}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === "fork" && (
        <div className="modal-back" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Fork a repo</h3>
            <div className="field">
              <label>OWNER/REPO</label>
              <input
                type="text"
                value={forkRef}
                onChange={(e) => setForkRef(e.target.value)}
                placeholder="octocat/hello-world"
                spellCheck={false}
              />
              <div className="note">Forks it to your account and clones it next to your other spaces.</div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn primary" disabled={!!busy || !forkRef.includes("/")} onClick={doFork}>
                {busy === "Fork" ? "Forking…" : "Fork & clone"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
