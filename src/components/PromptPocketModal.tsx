// Prompt Pocket modal — port of the hermes-prompt-pocket (MIT) library dialog,
// rebuilt natively for this app (copy-only workflow: no auto-insert).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyImport,
  createPrompt,
  deletePrompt,
  previewImport,
  searchPrompts,
  serializeDoc,
  updatePrompt,
  type ImportPreview,
  type PromptLibraryDoc,
  type PromptRecord,
} from "../lib/prompt-pocket-core";
import {
  loadLibrary,
  mutateLibrary,
  onPocketChanged,
} from "../lib/prompt-pocket-store";

type View = "list" | "editor" | "import";

export default function PromptPocketModal({ onClose }: { onClose: () => void }) {
  const [doc, setDoc] = useState<PromptLibraryDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("list");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // editor state
  const [editSnapshot, setEditSnapshot] = useState<PromptRecord | null>(null);
  const [editName, setEditName] = useState("");
  const [editText, setEditText] = useState("");
  const [editBase, setEditBase] = useState({ name: "", text: "" });

  // import state
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);

  // delete confirm
  const [confirmDelete, setConfirmDelete] = useState<PromptRecord | null>(null);

  // clipboard fallback
  const [copyFallback, setCopyFallback] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setDoc(await loadLibrary());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Another window changed the library — reload the list (editor/import
    // views keep their own snapshots; stale writes are rejected on save).
    return onPocketChanged(() => {
      setView((v) => {
        if (v === "list") void refresh();
        return v;
      });
    });
  }, [refresh]);

  // Focus search once the library is loaded.
  useEffect(() => {
    if (!loading && view === "list") searchRef.current?.focus();
  }, [loading, view]);

  const hits = useMemo(
    () => (doc ? searchPrompts(doc, query) : []),
    [doc, query],
  );
  const selected = hits.find((p) => p.id === selectedId) ?? hits[0] ?? null;

  useEffect(() => {
    if (selectedId && !hits.some((p) => p.id === selectedId)) setSelectedId(null);
  }, [hits, selectedId]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2600);
  };

  const copyText = useCallback(async (text: string, label: string) => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      flash(`${label} copied — paste it into the composer yourself.`);
    } catch {
      setCopyFallback(text); // selectable-text fallback per spec
    }
  }, []);

  const closeGuarded = () => {
    if (view === "editor" && (editName !== editBase.name || editText !== editBase.text)) {
      if (!window.confirm("Discard your unsaved prompt edits?")) return;
    }
    if (view === "import" && (importText.trim() || importPreview)) {
      if (!window.confirm("Discard this import?")) return;
    }
    onClose();
  };

  // --- mutations -----------------------------------------------------------

  const saveEditor = async () => {
    setError(null);
    try {
      if (editSnapshot) {
        await mutateLibrary((cur) => {
          const { doc: next, record } = updatePrompt(cur, editSnapshot.id, editSnapshot, editName, editText);
          return { doc: next, result: record };
        });
        flash("Prompt updated.");
      } else {
        const rec = await mutateLibrary((cur) => {
          const { doc: next, record } = createPrompt(cur, editName, editText);
          return { doc: next, result: record };
        });
        setSelectedId(rec.id);
        flash("Prompt saved.");
      }
      setView("list");
      setEditSnapshot(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    setError(null);
    try {
      await mutateLibrary((cur) => ({
        doc: deletePrompt(cur, confirmDelete.id, confirmDelete),
        result: null,
      }));
      flash(`Deleted "${confirmDelete.name}".`);
      setConfirmDelete(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runImportPreview = () => {
    setError(null);
    if (!doc) return;
    try {
      setImportPreview(previewImport(doc, importText));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runImportApply = async () => {
    if (!importPreview) return;
    setError(null);
    try {
      await mutateLibrary((cur) => ({ doc: applyImport(cur, importPreview), result: null }));
      const { added, skipped, copies } = importPreview;
      flash(`Import applied: ${added} added, ${skipped} skipped, ${copies} copied.`);
      setImportPreview(null);
      setImportText("");
      setView("list");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openNew = () => {
    setEditSnapshot(null);
    setEditName("");
    setEditText("");
    setEditBase({ name: "", text: "" });
    setConfirmDelete(null);
    setView("editor");
  };
  const openEdit = (p: PromptRecord) => {
    setEditSnapshot({ ...p });
    setEditName(p.name);
    setEditText(p.text);
    setEditBase({ name: p.name, text: p.text });
    setConfirmDelete(null);
    setView("editor");
  };

  // --- keyboard ------------------------------------------------------------
  const onListKey = (e: React.KeyboardEvent) => {
    if (view !== "list" || copyFallback) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (hits.length === 0) return;
      const i = hits.findIndex((p) => p.id === (selected?.id ?? null));
      const next = e.key === "ArrowDown" ? (i + 1) % hits.length : (i - 1 + hits.length) % hits.length;
      setSelectedId(hits[next].id);
    } else if (e.key === "Enter" && selected) {
      // Don't hijack Enter while typing in the search box.
      if ((e.target as HTMLElement).tagName !== "INPUT") {
        e.preventDefault();
        void copyText(selected.text, `"${selected.name}"`);
      }
    } else if (e.key === "Escape") {
      closeGuarded();
    }
  };

  const dirtyEditor = view === "editor" && (editName !== editBase.name || editText !== editBase.text);

  return (
    <div className="modal-back" onClick={closeGuarded} onKeyDown={onListKey}>
      <div
        className="modal"
        style={{ maxWidth: 760, width: "94vw" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Prompt Pocket library"
      >
        <h3>Prompt Pocket</h3>
        <div className="field">
          <div className="note" style={{ marginTop: -8 }}>
            Local-only prompt library — copy a prompt, paste it into the composer yourself. Nothing is sent anywhere.
          </div>
        </div>

        {error && <div className="status-out" style={{ marginBottom: 10 }}>{error}</div>}
        {notice && <div className="note" style={{ marginBottom: 10, color: "var(--gold)" }}>{notice}</div>}

        {loading && <div className="note">Loading library…</div>}

        {!loading && view === "list" && (
          <>
            <div className="field">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search prompts…"
                spellCheck={false}
                style={{ width: "100%" }}
              />
            </div>

            <div style={{ display: "flex", gap: 12, minHeight: 220, maxHeight: 340 }}>
              <div style={{ flex: "0 0 42%", overflowY: "auto", border: "1px solid var(--bg4)", borderRadius: 6 }}>
                {hits.length === 0 && (
                  <div className="note" style={{ padding: 12 }}>
                    {query ? "No prompts match." : "No prompts yet — save your first one."}
                  </div>
                )}
                {hits.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    onDoubleClick={() => void copyText(p.text, `"${p.name}"`)}
                    style={{
                      padding: "8px 10px",
                      cursor: "pointer",
                      borderBottom: "1px solid var(--bg3)",
                      background: selected?.id === p.id ? "var(--bg3)" : "transparent",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                    <div className="note" style={{ marginTop: 2 }}>
                      {new Date(p.updatedAt).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ flex: 1, overflowY: "auto", border: "1px solid var(--bg4)", borderRadius: 6, padding: 12 }}>
                {selected ? (
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12.5, fontFamily: "inherit" }}>
                    {selected.text}
                  </pre>
                ) : (
                  <div className="note">Select a prompt to preview it.</div>
                )}
              </div>
            </div>

            {confirmDelete ? (
              <div className="field" style={{ marginTop: 12 }}>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  Delete <b>"{confirmDelete.name}"</b>? This can't be undone.
                </div>
                <div className="modal-actions" style={{ marginTop: 0, justifyContent: "flex-start" }}>
                  <button className="btn" onClick={() => setConfirmDelete(null)}>Keep it</button>
                  <button className="btn primary" onClick={doDelete}>Delete</button>
                </div>
              </div>
            ) : (
              <div className="modal-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
                <button className="btn primary" onClick={openNew}>New prompt</button>
                <button className="btn" disabled={!selected} onClick={() => selected && void copyText(selected.text, `"${selected.name}"`)}>
                  Copy prompt
                </button>
                <button className="btn" disabled={!selected} onClick={() => selected && openEdit(selected)}>Edit</button>
                <button className="btn" disabled={!selected} onClick={() => selected && setConfirmDelete(selected)}>Delete</button>
                <span style={{ flex: 1 }} />
                <button className="btn" disabled={!doc || doc.prompts.length === 0} onClick={() => doc && void copyText(serializeDoc(doc), "Library export JSON")}>
                  Copy export JSON
                </button>
                <button className="btn" onClick={() => { setImportText(""); setImportPreview(null); setView("import"); }}>Import</button>
              </div>
            )}

            <div className="field" style={{ marginTop: 12 }}>
              <div className="note">
                ↑↓ to move, Enter to copy, Esc to close. Back up with Copy export JSON — the library lives in this app's local storage.
              </div>
            </div>
          </>
        )}

        {!loading && view === "editor" && (
          <>
            <div className="field">
              <label>NAME</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="e.g. Code review checklist"
                spellCheck={false}
                style={{ width: "100%" }}
                autoFocus
              />
            </div>
            <div className="field">
              <label>PROMPT TEXT</label>
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                placeholder="Paste the prompt text here…"
                spellCheck={false}
                rows={10}
                style={{ width: "100%", resize: "vertical" }}
              />
              <div className="note">Text is stored exactly as written — whitespace and all.</div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={closeGuarded}>Cancel</button>
              <button className="btn primary" onClick={saveEditor} disabled={!editName.trim() || !editText.trim()}>
                {editSnapshot ? "Save changes" : "Save prompt"}
              </button>
            </div>
          </>
        )}

        {!loading && view === "import" && (
          <>
            {!importPreview ? (
              <>
                <div className="field">
                  <label>PASTE EXPORT JSON</label>
                  <textarea
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder='Paste a Prompt Pocket export ({"schemaVersion": 1, …})…'
                    spellCheck={false}
                    rows={10}
                    style={{ width: "100%", resize: "vertical" }}
                    autoFocus
                  />
                  <div className="note">Import is additive — nothing already saved is replaced.</div>
                </div>
                <div className="modal-actions">
                  <button className="btn" onClick={() => setView("list")}>Back</button>
                  <button className="btn primary" onClick={runImportPreview} disabled={!importText.trim()}>
                    Preview import
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <div style={{ fontSize: 13, marginBottom: 8 }}>Import preview (nothing written yet):</div>
                  <div className="note">• {importPreview.added} new prompt(s) will be added</div>
                  <div className="note">• {importPreview.skipped} identical prompt(s) will be skipped</div>
                  <div className="note">• {importPreview.copies} conflicting prompt(s) will be imported as copies</div>
                </div>
                <div className="modal-actions">
                  <button className="btn" onClick={() => setImportPreview(null)}>Back</button>
                  <button className="btn primary" onClick={runImportApply}>Apply import</button>
                </div>
              </>
            )}
          </>
        )}

        {copyFallback !== null && (
          <div className="field" style={{ marginTop: 12 }}>
            <label>CLIPBOARD UNAVAILABLE — SELECT AND COPY MANUALLY</label>
            <textarea readOnly value={copyFallback} rows={6} style={{ width: "100%" }} autoFocus
              onFocus={(e) => e.target.select()} />
            <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
              <button className="btn" onClick={(e) => {
                const ta = (e.target as HTMLElement).closest(".field")?.querySelector("textarea");
                ta?.select();
                try { document.execCommand("copy"); } catch { /* manual copy */ }
              }}>Select text</button>
              <button className="btn" onClick={() => setCopyFallback(null)}>Done</button>
            </div>
          </div>
        )}

        {dirtyEditor && <div className="note">Unsaved edits — closing will ask to discard them.</div>}
      </div>
    </div>
  );
}
