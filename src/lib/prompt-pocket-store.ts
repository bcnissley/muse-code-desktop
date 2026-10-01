/**
 * Prompt Pocket — IndexedDB persistence layer.
 *
 * Implements SPEC §4 of xraysight/hermes-prompt-pocket (MIT):
 *   database `prompt-pocket`, version 1, object store `documents`, key `library`.
 *
 * Contract:
 *  - One validated library document per database. Absent key (confirmed by
 *    count) = empty v1 document. A present-but-undefined value is malformed.
 *  - Every mutation runs as a SINGLE readwrite transaction: read current,
 *    validate it, apply one synchronous mutation to an isolated next doc,
 *    validate the next doc, issue one put, and report success only after the
 *    transaction completes. IndexedDB serializes conflicting transactions on
 *    the same origin/database/store, so two windows can't silently clobber
 *    each other's writes.
 *  - Malformed storage fails closed — it is never silently replaced.
 *  - BroadcastChannel nudges other open windows to refresh after a commit.
 */

import {
  PocketError,
  emptyLibrary,
  validateLibraryDoc,
  type PromptLibraryDoc,
} from "./prompt-pocket-core";

const DB_NAME = "prompt-pocket";
const DB_VERSION = 1;
const STORE = "documents";
const KEY = "library";
const BC_NAME = "prompt-pocket-refresh";

let dbPromise: Promise<IDBDatabase> | null = null;
let bc: BroadcastChannel | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another version opening elsewhere: drop our connection so the
        // upgrade can proceed instead of deadlocking it.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () =>
        reject(new PocketError(`could not open prompt library: ${req.error?.message ?? "unknown error"}`));
      req.onblocked = () =>
        reject(new PocketError("prompt library is blocked by another open window — close it and retry"));
    });
  }
  return dbPromise;
}

export function closePocketDb(): void {
  if (dbPromise) {
    void dbPromise.then((db) => db.close()).catch(() => {});
    dbPromise = null;
  }
  if (bc) {
    bc.close();
    bc = null;
  }
}

function notifyOtherWindows(): void {
  try {
    if (!bc) bc = new BroadcastChannel(BC_NAME);
    bc.postMessage({ type: "prompt-pocket-changed", at: Date.now() });
  } catch {
    /* BroadcastChannel unavailable — other windows just won't auto-refresh */
  }
}

/** Subscribe to cross-window change nudges. Returns an unsubscribe fn. */
export function onPocketChanged(cb: () => void): () => void {
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(BC_NAME);
    ch.onmessage = (e) => {
      if (e?.data?.type === "prompt-pocket-changed") cb();
    };
  } catch {
    return () => {};
  }
  return () => ch?.close();
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new PocketError(`library write failed: ${tx.error?.message ?? "unknown error"}`));
    tx.onabort = () => reject(new PocketError(`library write aborted: ${tx.error?.message ?? "unknown error"}`));
  });
}

/** Read the current document inside an existing transaction's store. */
function readCurrent(store: IDBObjectStore): Promise<PromptLibraryDoc> {
  return new Promise((resolve, reject) => {
    const countReq = store.count(KEY);
    countReq.onsuccess = () => {
      if (countReq.result === 0) {
        resolve(emptyLibrary());
        return;
      }
      const getReq = store.get(KEY);
      getReq.onsuccess = () => {
        const v = getReq.result;
        if (v === undefined)
          return reject(new PocketError("prompt library data is malformed (present but empty)"));
        try {
          resolve(validateLibraryDoc(v));
        } catch (e) {
          reject(e);
        }
      };
      getReq.onerror = () =>
        reject(new PocketError(`could not read prompt library: ${getReq.error?.message ?? "unknown error"}`));
    };
    countReq.onerror = () =>
      reject(new PocketError(`could not read prompt library: ${countReq.error?.message ?? "unknown error"}`));
  });
}

/** Load the current library. Fails closed on malformed data. */
export async function loadLibrary(): Promise<PromptLibraryDoc> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  const doc = await readCurrent(store);
  await txDone(tx).catch(() => {});
  return doc;
}

/**
 * Run one mutation inside a single readwrite transaction.
 * `fn` receives the current validated doc and must return the next doc
 * plus an optional result. The next doc is validated before the put;
 * success is reported only after the transaction completes.
 */
export async function mutateLibrary<T>(
  fn: (current: PromptLibraryDoc) => { doc: PromptLibraryDoc; result: T },
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  let out: T;
  try {
    const current = await readCurrent(store);
    // Isolated next doc: fn must not retain references into `current`.
    const { doc: next, result } = fn(current);
    const clean = validateLibraryDoc(JSON.parse(JSON.stringify(next)) as unknown);
    await new Promise<void>((resolve, reject) => {
      const putReq = store.put(clean, KEY);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () =>
        reject(new PocketError(`could not write prompt library: ${putReq.error?.message ?? "unknown error"}`));
    });
    out = result;
  } catch (e) {
    try {
      tx.abort();
    } catch {
      /* already finished */
    }
    throw e;
  }
  await txDone(tx);
  notifyOtherWindows();
  return out;
}
