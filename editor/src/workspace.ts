// File tabs: several designs open at once. Pure bookkeeping, no DOM. The tab that is showing lives in the Doc (and the
// server panel); every other tab is parked here as a snapshot. The same server file is never open in two tabs: opening
// it again switches to its tab. A duplicate is a new, unsaved file.
import { Doc, emptyState, type ClipData, type DocSnapshot, type DocState } from "./doc";
import type { Origin } from "./job";

export const DEFAULT_ORIGIN: Origin = { mode: "current-position", anchor: "bottom-left" };

/** What the server panel knows about the file in a tab. */
export interface FileMeta {
  /** The draft on the server that Save updates; null until the first Save (or after the design was sent). */
  jobId: string | null;
  origin: Origin;
  /** Fingerprint of the page when it was last saved, to tell whether there is anything unsaved. */
  savedKey: string;
  /** The copy kept on this computer that this file was opened from. */
  openedLocal: string | null;
  /** The sent or finished file this one was opened as a copy of (so opening it again finds this tab). */
  sourceId: string | null;
}

export const blankMeta = (): FileMeta => ({ jobId: null, origin: DEFAULT_ORIGIN, savedKey: "", openedLocal: null, sourceId: null });

export interface FileTab {
  id: number;
  name: string;
  snap: DocSnapshot;
  meta: FileMeta;
  /** The pupil gave it a name: stop naming it after its file on the server. */
  renamed?: boolean;
}

/** A fingerprint of what would be saved: the material, the shapes and the dimensions. */
export const fileKey = (s: Pick<DocState, "materialId" | "dimensions"> & { objects: DocState["objects"] }): string =>
  JSON.stringify([s.materialId, s.objects.map((o) => [o.path, o.matrix, o.layer, o.tabs, o.settings]), s.dimensions]);

/** True if the tab holds something that is not saved. An empty tab has nothing to lose. */
export const isDirty = (state: DocState, savedKey: string): boolean => state.objects.length > 0 && fileKey(state) !== savedKey;

/** A short, readable tab name for a file that has no name of its own: "Design 16 Oct 14:02" (never the long job id). */
export function designName(when: string | Date, copy = false): string {
  const d = typeof when === "string" ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) return copy ? "Copy of design" : "Design";
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]!;
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
  return `${copy ? "Copy of design" : "Design"} ${d.getDate()} ${mon} ${hh}:${mm}`;
}

/** `base`, or `base 2`, `base 3`... so no two tabs share a name. */
export function uniqueName(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

/** The ids by which a file may already be open: its draft id, the file it is a copy of, or the local copy it came from. */
export interface FileRef { jobId?: string | null; sourceId?: string | null; localId?: string | null }

export function matches(meta: FileMeta, ref: FileRef): boolean {
  if (ref.jobId && meta.jobId === ref.jobId) return true;
  if (ref.sourceId && meta.jobId === null && meta.sourceId === ref.sourceId) return true;
  if (ref.sourceId && meta.jobId === ref.sourceId) return true;
  if (ref.localId && meta.openedLocal === ref.localId) return true;
  return false;
}

export class Workspace {
  tabs: FileTab[];
  activeId: number;
  private nextId = 1;

  constructor() {
    const first = this.make("Untitled", { state: emptyState(), undo: [], redo: [] }, blankMeta());
    this.tabs = [first];
    this.activeId = first.id;
  }

  private make(name: string, snap: DocSnapshot, meta: FileMeta): FileTab {
    return { id: this.nextId++, name, snap, meta };
  }

  active(): FileTab { return this.tabs.find((t) => t.id === this.activeId)!; }
  get(id: number): FileTab | undefined { return this.tabs.find((t) => t.id === id); }
  names(): string[] { return this.tabs.map((t) => t.name); }

  /** The tab already holding this file, if any. */
  find(ref: FileRef): FileTab | undefined { return this.tabs.find((t) => matches(t.meta, ref)); }

  /** A new tab right after `after` (default: the active one). It is not activated: the caller parks the current page first. */
  add(name: string, snap: DocSnapshot, meta: FileMeta, after: FileTab = this.active()): FileTab {
    const tab = this.make(uniqueName(this.names(), name), snap, meta);
    const at = this.tabs.findIndex((t) => t.id === after.id);
    this.tabs.splice(at + 1, 0, tab);
    return tab;
  }

  /** A copy as a new file: same shapes and settings, no server id, no undo history. */
  duplicate(source: FileTab): FileTab {
    const snap: DocSnapshot = { state: structuredClone(source.snap.state), undo: [], redo: [] };
    const meta: FileMeta = { ...blankMeta(), origin: structuredClone(source.meta.origin) };
    return this.add(`${source.name} copy`, snap, meta, source);
  }

  /** Remove a tab. Returns the tab to show instead if the active one went (a blank one if it was the last). */
  close(id: number): FileTab | null {
    const at = this.tabs.findIndex((t) => t.id === id);
    if (at < 0) return null;
    this.tabs.splice(at, 1);
    if (!this.tabs.length) {
      const blank = this.make("Untitled", { state: emptyState(), undo: [], redo: [] }, blankMeta());
      this.tabs.push(blank);
      this.activeId = blank.id;
      return blank;
    }
    if (id !== this.activeId) return null;
    const next = this.tabs[Math.min(at, this.tabs.length - 1)]!;
    this.activeId = next.id;
    return next;
  }

  /** True when there is nothing to lose: one empty, unsaved tab. */
  pristine(activeEmpty: boolean): boolean {
    return this.tabs.length === 1 && activeEmpty && !this.tabs[0]!.meta.jobId;
  }

  /** Show the tabs kept in the browser. Into an untouched workspace they replace it; otherwise they are added after the tabs already open (a file already open is not added twice). Returns the tab to show. */
  absorb(m: Mirror, replace: boolean): FileTab {
    const incoming = m.tabs.map((t) => ({ t, tab: this.make(t.name, { state: t.state, undo: [], redo: [] }, t.meta) }));
    if (replace) this.tabs = [];
    let active: FileTab | undefined;
    incoming.forEach(({ t, tab }, i) => {
      const dup = this.tabs.find((x) => (tab.meta.jobId && x.meta.jobId === tab.meta.jobId) || (tab.meta.openedLocal && x.meta.openedLocal === tab.meta.openedLocal));
      if (dup) { if (i === m.active) active = dup; return; }
      tab.renamed = t.renamed;
      this.tabs.push(tab);
      if (i === m.active) active = tab;
    });
    if (!this.tabs.length) this.tabs.push(this.make("Untitled", { state: emptyState(), undo: [], redo: [] }, blankMeta()));
    const show = replace ? active ?? this.tabs[0]! : this.active();
    this.activeId = show.id;
    return show;
  }

  /** Back to one empty tab (sign-out: the next pupil must find nothing). */
  reset(): FileTab {
    this.tabs = [];
    const blank = this.make("Untitled", { state: emptyState(), undo: [], redo: [] }, blankMeta());
    this.tabs.push(blank);
    this.activeId = blank.id;
    return blank;
  }
}

/** Put shapes into a parked tab (as one undoable step there). Returns how many were added. */
export function pasteIntoSnapshot(snap: DocSnapshot, data: ClipData): number {
  const d = new Doc();
  d.restore(snap);
  d.checkpoint();
  const n = d.pasteIn(data, 0, 0).length;
  return n;
}

/** A new snapshot holding just these shapes, with the given material. */
export function snapshotOf(data: ClipData, materialId: string): DocSnapshot {
  const d = new Doc();
  d.state.materialId = materialId;
  d.pasteIn(data, 0, 0);
  return d.snapshot();
}


// ---- keeping the open tabs in this browser ----
// Every change is mirrored to local storage, keyed by who is signed in, so the tabs come back after a refresh or when the
// same person signs in again. Only pupil IDs are stored, never names. Undo history is not kept (it is big and a refresh ends it).

export interface MirrorTab { name: string; renamed?: boolean; state: DocState; meta: FileMeta }
export interface Mirror { v: 1; savedAt: string; active: number; tabs: MirrorTab[] }

export const mirrorKey = (owner: string): string => `kerf.workspace.${owner}`;
const MAX_TABS = 30;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const defaultStore = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** The tabs as text. `live` is the page showing now (its snapshot in the workspace is stale). */
export function serializeMirror(ws: Workspace, live: { state: DocState; meta: FileMeta }, now: Date = new Date()): string {
  const tabs: MirrorTab[] = ws.tabs.map((t) => {
    const isLive = t.id === ws.activeId;
    return { name: t.name, renamed: t.renamed, state: isLive ? live.state : t.snap.state, meta: isLive ? live.meta : t.meta };
  });
  const m: Mirror = { v: 1, savedAt: now.toISOString(), active: Math.max(0, ws.tabs.findIndex((t) => t.id === ws.activeId)), tabs };
  return JSON.stringify(m);
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isPoint = (p: unknown): boolean => !!p && isNum((p as { x?: unknown }).x) && isNum((p as { y?: unknown }).y);
const validObject = (o: unknown): boolean => {
  const x = o as { id?: unknown; layer?: unknown; matrix?: unknown; path?: { start?: unknown; segs?: unknown; closed?: unknown } } | null;
  return !!x && isNum(x.id) && (x.layer === "cut" || x.layer === "score" || x.layer === "ignore")
    && Array.isArray(x.matrix) && x.matrix.length === 6 && x.matrix.every(isNum)
    && !!x.path && isPoint(x.path.start) && Array.isArray(x.path.segs) && typeof x.path.closed === "boolean"
    && x.path.segs.every((g: { t?: unknown; to?: unknown }) => !!g && (g.t === "l" || g.t === "a" || g.t === "c") && isPoint(g.to));
};

/** One tab from storage, checked and filled in; null if anything about it is off. */
function cleanTab(t: MirrorTab | undefined): MirrorTab | null {
  if (!t || typeof t.name !== "string" || !t.state || !Array.isArray(t.state.objects) || !t.state.objects.every(validObject)) return null;
  const meta = t.meta ?? blankMeta();
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    name: t.name.slice(0, 60), renamed: t.renamed === true,
    state: { ...emptyState(), ...t.state },
    meta: { jobId: str(meta.jobId), origin: meta.origin?.mode === "absolute" || meta.origin?.mode === "current-position" ? meta.origin : DEFAULT_ORIGIN, savedKey: typeof meta.savedKey === "string" ? meta.savedKey : "", openedLocal: str(meta.openedLocal), sourceId: str(meta.sourceId) },
  };
}

/** Read what serializeMirror wrote. Anything unexpected gives null (a damaged or foreign entry is ignored, never half-loaded). */
export function parseMirror(text: string | null): Mirror | null {
  if (!text) return null;
  try {
    const m = JSON.parse(text) as Mirror;
    if (m?.v !== 1 || !Array.isArray(m.tabs) || !m.tabs.length || m.tabs.length > MAX_TABS) return null;
    const tabs: MirrorTab[] = [];
    for (const t of m.tabs) {
      const c = cleanTab(t);
      if (!c) return null;
      tabs.push(c);
    }
    return { v: 1, savedAt: String(m.savedAt), active: isNum(m.active) && m.active >= 0 && m.active < tabs.length ? m.active : 0, tabs };
  } catch { return null; }
}

export const readMirror = (owner: string, store: Store | null = defaultStore()): Mirror | null => {
  try { return parseMirror(store?.getItem(mirrorKey(owner)) ?? null); } catch { return null; }
};

/** Write the mirror. False if the browser would not take it (storage full or blocked). */
export function writeMirror(owner: string, text: string, store: Store | null = defaultStore()): boolean {
  if (!store) return false;
  try { store.setItem(mirrorKey(owner), text); return true; } catch { return false; }
}

export function removeMirror(owner: string, store: Store | null = defaultStore()): void {
  try { store?.removeItem(mirrorKey(owner)); } catch { /* nothing to do */ }
}


// ---- files closed in this browser ----
// A tab that is closed keeps its file here (per person, the newest few) so it can be opened again from My files > On this computer,
// including work the server never received. Opening reads only the signed-in person's own key.

export interface ClosedFile extends MirrorTab { id: string; closedAt: string }
export const closedKey = (owner: string): string => `kerf.closed.${owner}`;
export const MAX_CLOSED = 20;

export function readClosed(owner: string, store: Store | null = defaultStore()): ClosedFile[] {
  try {
    const v = JSON.parse(store?.getItem(closedKey(owner)) ?? "[]") as ClosedFile[];
    if (!Array.isArray(v)) return [];
    return v.flatMap((f) => { const c = f && typeof f.id === "string" ? cleanTab(f) : null; return c ? [{ ...c, id: f.id, closedAt: String(f.closedAt) }] : []; });
  } catch { return []; }
}

/** Keep a closed file (newest first). The same server file is kept once. Returns false if the browser would not take it. */
export function addClosed(owner: string, tab: MirrorTab, store: Store | null = defaultStore(), now: Date = new Date()): boolean {
  if (!store || !tab.state.objects.length) return false;
  const entry: ClosedFile = { ...tab, id: `closed-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, closedAt: now.toISOString() };
  let all = [entry, ...readClosed(owner, store).filter((f) => !(tab.meta.jobId && f.meta.jobId === tab.meta.jobId))].slice(0, MAX_CLOSED);
  for (;;) { // if it does not fit, let the oldest go and try again
    try { store.setItem(closedKey(owner), JSON.stringify(all)); return true; } catch {
      if (all.length <= 1) return false;
      all = all.slice(0, -1);
    }
  }
}

export function removeClosed(owner: string, id: string, store: Store | null = defaultStore()): void {
  try { store?.setItem(closedKey(owner), JSON.stringify(readClosed(owner, store).filter((f) => f.id !== id))); } catch { /* nothing to do */ }
}
