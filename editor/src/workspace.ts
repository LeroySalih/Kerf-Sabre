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
