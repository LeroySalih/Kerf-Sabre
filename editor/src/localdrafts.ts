// A design that could not be saved to the server is kept in this browser instead, so a pupil never loses work to a network or server problem.
// It lives only in this browser's local storage (never sent anywhere), holds the pupil ID but no name, and is removed once it reaches the server.
import type { JobDoc } from "./job";

export interface LocalDraft {
  id: string;
  savedAt: string;
  /** Why the server did not take it: shown so the pupil (and a teacher helping) can see what went wrong. */
  reason: string;
  job: JobDoc;
}

const KEY = "kerf.localdrafts";
const MAX = 10; // the newest ten: browser storage is small and this is a safety net, not an archive

type Store = Pick<Storage, "getItem" | "setItem">;
const defaultStore = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

function read(store: Store | null): LocalDraft[] {
  try {
    const v = JSON.parse(store?.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((d) => d && typeof d.id === "string" && d.job && Array.isArray(d.job.objects)) : [];
  } catch { return []; }
}

/** The drafts kept here, newest first; only this pupil's when an ID is given. */
export function listLocal(pupilId?: string, store: Store | null = defaultStore()): LocalDraft[] {
  return read(store).filter((d) => !pupilId || d.job.pupilId === pupilId);
}

/** Keep a copy. Returns it, or null if the browser would not store it (full, blocked, private window). */
export function addLocal(job: JobDoc, reason: string, store: Store | null = defaultStore(), now: Date = new Date()): LocalDraft | null {
  if (!store) return null;
  const d: LocalDraft = { id: `local-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, savedAt: now.toISOString(), reason: reason.slice(0, 300), job };
  let all = [d, ...read(store)];
  for (;;) { // if it does not fit, let the oldest go and try again
    try { store.setItem(KEY, JSON.stringify(all.slice(0, MAX))); return d; } catch {
      if (all.length <= 1) return null;
      all = all.slice(0, -1);
    }
  }
}

export function removeLocal(id: string, store: Store | null = defaultStore()): void {
  try { store?.setItem(KEY, JSON.stringify(read(store).filter((d) => d.id !== id))); } catch { /* nothing to do */ }
}
