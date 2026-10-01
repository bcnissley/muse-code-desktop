/**
 * Prompt Pocket — shared pure core.
 *
 * Port of the data contract from xraysight/hermes-prompt-pocket (MIT),
 * SPEC.md "Prompt Pocket MVP specification", v1 document format.
 *
 * This module is deliberately UI-free: no DOM, no IndexedDB, no React.
 * Storage adapters (IndexedDB, per the spec) live in prompt-pocket-store.ts.
 * Everything here is unit-testable in plain node.
 *
 * v1 document:
 *   { schemaVersion: 1,
 *     prompts: [{ id, name, text, createdAt, updatedAt }] }
 */

export interface PromptRecord {
  id: string; // UUID
  name: string; // trimmed, nonblank, no surrounding whitespace
  text: string; // must contain non-whitespace; otherwise stored EXACTLY
  createdAt: string; // canonical UTC ISO
  updatedAt: string; // canonical UTC ISO, >= createdAt
}

export interface PromptLibraryDoc {
  schemaVersion: 1;
  prompts: PromptRecord[];
}

export class PocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PocketError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCanonicalIso(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) return false;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString() === s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const RECORD_KEYS = ["id", "name", "text", "createdAt", "updatedAt"] as const;
const DOC_KEYS = ["schemaVersion", "prompts"] as const;

/** Strict whole-record validation. Unknown fields are rejected. */
export function validatePromptRecord(r: unknown): PromptRecord {
  if (!isPlainObject(r)) throw new PocketError("prompt record must be an object");
  for (const k of Object.keys(r)) {
    if (!(RECORD_KEYS as readonly string[]).includes(k))
      throw new PocketError(`prompt record has unknown field: ${k}`);
  }
  const { id, name, text, createdAt, updatedAt } = r;
  if (typeof id !== "string" || !UUID_RE.test(id))
    throw new PocketError("prompt id must be a UUID");
  if (typeof name !== "string" || name.trim() === "" || name !== name.trim())
    throw new PocketError("prompt name must be nonblank with no surrounding whitespace");
  if (typeof text !== "string" || text.trim() === "")
    throw new PocketError("prompt text must contain non-whitespace content");
  if (!isCanonicalIso(createdAt))
    throw new PocketError("createdAt must be a canonical UTC ISO string");
  if (!isCanonicalIso(updatedAt))
    throw new PocketError("updatedAt must be a canonical UTC ISO string");
  if (updatedAt < createdAt)
    throw new PocketError("updatedAt must be >= createdAt");
  // Return a clean copy with fixed key order (stable serialization).
  return { id, name, text, createdAt, updatedAt };
}

/** Strict whole-document validation. Malformed input throws — never an empty fallback. */
export function validateLibraryDoc(doc: unknown): PromptLibraryDoc {
  if (!isPlainObject(doc)) throw new PocketError("library document must be an object");
  for (const k of Object.keys(doc)) {
    if (!(DOC_KEYS as readonly string[]).includes(k))
      throw new PocketError(`library document has unknown field: ${k}`);
  }
  if (doc.schemaVersion !== 1)
    throw new PocketError("library schemaVersion must be 1");
  if (!Array.isArray(doc.prompts))
    throw new PocketError("library prompts must be an array");
  const prompts = doc.prompts.map(validatePromptRecord);
  const seen = new Set<string>();
  for (const p of prompts) {
    if (seen.has(p.id)) throw new PocketError(`duplicate prompt id: ${p.id}`);
    seen.add(p.id);
  }
  return { schemaVersion: 1, prompts };
}

export function emptyLibrary(): PromptLibraryDoc {
  return { schemaVersion: 1, prompts: [] };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newUuid(): string {
  return crypto.randomUUID();
}

/** Deterministic serialization: fixed key order so deep-equality via
 *  JSON.stringify is reliable for stale-write detection. */
export function serializeDoc(doc: PromptLibraryDoc): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

export function docsEqual(a: PromptLibraryDoc, b: PromptLibraryDoc): boolean {
  return serializeDoc(a) === serializeDoc(b);
}

function recordsEqual(a: PromptRecord, b: PromptRecord): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.text === b.text &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt
  );
}

function cloneDoc(doc: PromptLibraryDoc): PromptLibraryDoc {
  return {
    schemaVersion: 1,
    prompts: doc.prompts.map((p) => ({ ...p })),
  };
}

// ---------------------------------------------------------------- mutations
// Each takes the CURRENT validated doc and returns the NEXT validated doc.
// The store runs these inside a single IndexedDB readwrite transaction.

export function createPrompt(
  doc: PromptLibraryDoc,
  name: string,
  text: string,
): { doc: PromptLibraryDoc; record: PromptRecord } {
  const cleanName = name.trim();
  if (cleanName === "") throw new PocketError("prompt name must be nonblank");
  if (text.trim() === "")
    throw new PocketError("prompt text must contain non-whitespace content");
  const now = nowIso();
  const record: PromptRecord = {
    id: newUuid(),
    name: cleanName,
    text, // stored EXACTLY — no trimming, no normalization
    createdAt: now,
    updatedAt: now,
  };
  const next = cloneDoc(doc);
  next.prompts.push(validatePromptRecord(record));
  return { doc: validateLibraryDoc(next), record };
}

export function updatePrompt(
  doc: PromptLibraryDoc,
  id: string,
  openedSnapshot: PromptRecord,
  name: string,
  text: string,
): { doc: PromptLibraryDoc; record: PromptRecord } {
  const idx = doc.prompts.findIndex((p) => p.id === id);
  if (idx < 0) throw new PocketError("prompt not found");
  const current = doc.prompts[idx];
  // Stale-edit guard: the record must be exactly what the editor opened.
  if (!recordsEqual(current, openedSnapshot))
    throw new PocketError(
      "this prompt changed in another window — reopen it and retry",
    );
  const cleanName = name.trim();
  if (cleanName === "") throw new PocketError("prompt name must be nonblank");
  if (text.trim() === "")
    throw new PocketError("prompt text must contain non-whitespace content");
  const changed = current.name !== cleanName || current.text !== text;
  const record: PromptRecord = {
    id: current.id,
    name: cleanName,
    text,
    createdAt: current.createdAt,
    updatedAt: changed ? nowIso() : current.updatedAt,
  };
  const next = cloneDoc(doc);
  next.prompts[idx] = validatePromptRecord(record);
  return { doc: validateLibraryDoc(next), record };
}

export function deletePrompt(
  doc: PromptLibraryDoc,
  id: string,
  openedSnapshot: PromptRecord,
): PromptLibraryDoc {
  const idx = doc.prompts.findIndex((p) => p.id === id);
  if (idx < 0) throw new PocketError("prompt not found");
  // Stale-delete guard: remove exactly the snapshot-matched record.
  if (!recordsEqual(doc.prompts[idx], openedSnapshot))
    throw new PocketError(
      "this prompt changed in another window — reopen it and retry",
    );
  const next = cloneDoc(doc);
  next.prompts.splice(idx, 1);
  return validateLibraryDoc(next);
}

// ---------------------------------------------------------------- search

/** Case-insensitive LITERAL substring match over name and text.
 *  Empty query returns everything, sorted updatedAt desc, then id asc. */
export function searchPrompts(
  doc: PromptLibraryDoc,
  query: string,
): PromptRecord[] {
  const q = query.toLowerCase();
  const hits = q
    ? doc.prompts.filter(
        (p) =>
          p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q),
      )
    : [...doc.prompts];
  hits.sort((a, b) =>
    a.updatedAt !== b.updatedAt
      ? b.updatedAt.localeCompare(a.updatedAt)
      : a.id.localeCompare(b.id),
  );
  return hits;
}

// ---------------------------------------------------------------- import

export interface ImportPreview {
  /** The exact current doc the preview was computed against (for stale-apply detection). */
  baseDoc: PromptLibraryDoc;
  /** The merged doc that Apply would write. */
  mergedDoc: PromptLibraryDoc;
  added: number; // brand-new ids
  skipped: number; // same id + identical record
  copies: number; // same id + differing fields -> imported as copy with fresh UUID
}

/** Parse + validate pasted JSON, then compute the additive merge preview.
 *  Non-mutating. Throws PocketError on malformed input. */
export function previewImport(
  current: PromptLibraryDoc,
  inputText: string,
): ImportPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputText);
  } catch {
    throw new PocketError("import text is not valid JSON");
  }
  const incoming = validateLibraryDoc(parsed);
  const byId = new Map(current.prompts.map((p) => [p.id, p]));
  const merged = cloneDoc(current);
  let added = 0;
  let skipped = 0;
  let copies = 0;
  for (const rec of incoming.prompts) {
    const existing = byId.get(rec.id);
    if (!existing) {
      merged.prompts.push({ ...rec });
      added++;
    } else if (recordsEqual(existing, rec)) {
      skipped++;
    } else {
      // Collision: keep the existing record, import the newcomer as a copy.
      const copy: PromptRecord = { ...rec, id: newUuid() };
      merged.prompts.push(copy);
      byId.set(copy.id, copy);
      copies++;
    }
  }
  return {
    baseDoc: cloneDoc(current),
    mergedDoc: validateLibraryDoc(merged),
    added,
    skipped,
    copies,
  };
}

/** Re-check the preview inside the write transaction: if the live doc moved
 *  since the preview, the import must be re-previewed. */
export function applyImport(
  liveDoc: PromptLibraryDoc,
  preview: ImportPreview,
): PromptLibraryDoc {
  if (!docsEqual(liveDoc, preview.baseDoc))
    throw new PocketError(
      "the library changed since this import was previewed — preview again",
    );
  return validateLibraryDoc(preview.mergedDoc);
}
