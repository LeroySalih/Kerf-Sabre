// Document state with snapshot undo/redo. Edits change object matrices, never source geometry.
import { multiply, translation, type Matrix, type Path } from "./geometry";
import { DEFAULT_MATERIAL_ID } from "./presets";
import type { Dimension } from "./dimensions";
import type { TabSpec } from "./tabs";
import type { TextSpec } from "./text";

export type LayerType = "score" | "cut";

export interface DocObject {
  id: number;
  path: Path; // design space, never mutated after creation
  matrix: Matrix; // Design -> Bed
  layer: LayerType;
  /** Objects sharing a group id are selected and moved together. One level only. */
  group?: number;
  /** Set on every contour of a live text object; see DocState.texts. Cleared by Convert to Path. */
  textId?: number;
  /** Per-shape override of the material's power/speed, e.g. one cell of a material test grid. */
  settings?: ShapeSettings;
  /** Tabs (bridges) left uncut on a closed Cut outline. Applied when exporting and when generating G-code. */
  tabs?: TabSpec;
}

export interface ShapeSettings {
  powerPct: number;
  speedMmPerS: number;
}

/** What a copy carries: the shapes with their groups, layers and (live) text specs. Ids are renumbered on paste. */
export interface ClipData {
  kerfSabre: 1;
  objects: { path: Path; matrix: Matrix; layer: LayerType; group?: number; textId?: number; settings?: ShapeSettings; tabs?: TabSpec }[];
  texts: Record<number, TextSpec>;
}

export interface DocState {
  objects: DocObject[];
  nextId: number;
  nextGroup: number;
  /** Editable text behind textId contours: change the spec and the contours are regenerated. */
  texts: Record<number, TextSpec>;
  nextText: number;
  /** Selected material preset (shared/preset.schema.json id). A job records it with its version. */
  materialId: string;
  /** Dimension annotations. Not shapes: never cut, exported or sent to the Cutter. */
  dimensions: Dimension[];
  nextDim: number;
}

export class Doc {
  state: DocState = { objects: [], nextId: 1, nextGroup: 1, texts: {}, nextText: 1, materialId: DEFAULT_MATERIAL_ID, dimensions: [], nextDim: 1 };
  private undoStack: DocState[] = [];
  private redoStack: DocState[] = [];

  /** Forget everything, including undo history (a new pupil must not be able to undo into the last one's design). */
  reset(): void {
    this.state = new Doc().state;
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Call before a mutation to make it undoable. */
  checkpoint(): void {
    this.undoStack.push(structuredClone(this.state));
    this.redoStack = [];
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.state);
    this.state = prev;
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.state);
    this.state = next;
    return true;
  }

  add(path: Path, matrix: Matrix, layer: LayerType = "cut"): DocObject {
    const obj: DocObject = { id: this.state.nextId++, path, matrix, layer };
    this.state.objects.push(obj);
    return obj;
  }

  newDimId(): string {
    return `d${this.state.nextDim++}`;
  }

  addDimensions(dims: Dimension[]): void {
    this.state.dimensions.push(...dims);
  }

  removeDimensions(ids: string[]): void {
    this.state.dimensions = this.state.dimensions.filter((d) => !ids.includes(d.id));
  }

  get(id: number): DocObject | undefined {
    return this.state.objects.find((o) => o.id === id);
  }

  remove(ids: number[]): void {
    this.state.objects = this.state.objects.filter((o) => !ids.includes(o.id));
  }

  /** Pre-multiply: apply `m` after the object's current placement. */
  transform(id: number, m: Matrix): void {
    const o = this.get(id);
    if (o) o.matrix = multiply(m, o.matrix);
  }

  setLayer(ids: number[], layer: LayerType): void {
    for (const o of this.state.objects) if (ids.includes(o.id)) o.layer = layer;
  }

  /** Ids plus every other member of any group they belong to. */
  expand(ids: Iterable<number>): number[] {
    const set = new Set(ids);
    const groups = new Set(this.state.objects.filter((o) => set.has(o.id) && o.group !== undefined).map((o) => o.group));
    for (const o of this.state.objects) if (o.group !== undefined && groups.has(o.group)) set.add(o.id);
    return [...set];
  }

  /** Group the given objects (replacing any earlier grouping of them). Needs 2+ objects; returns the group id. */
  group(ids: number[]): number | undefined {
    const members = this.expand(ids);
    if (members.length < 2) return undefined;
    const g = this.state.nextGroup++;
    for (const o of this.state.objects) if (members.includes(o.id)) o.group = g;
    return g;
  }

  /** Dissolve every group that any of the given objects belong to. */
  ungroup(ids: number[]): void {
    for (const o of this.state.objects) if (this.expand(ids).includes(o.id)) delete o.group;
  }

  /** Add a live text object (one contour object per glyph contour, grouped). Returns its text id. */
  addText(spec: TextSpec, paths: Path[], matrix: Matrix, layer: LayerType): number {
    const id = this.state.nextText++;
    this.state.texts[id] = spec;
    this.fillText(id, paths, matrix, layer, paths.length > 1 ? this.state.nextGroup++ : undefined);
    return id;
  }

  private fillText(textId: number, paths: Path[], matrix: Matrix, layer: LayerType, group: number | undefined): number[] {
    return paths.map((path) => {
      const o = this.add(path, matrix, layer);
      o.textId = textId;
      if (group !== undefined) o.group = group;
      return o.id;
    });
  }

  /** Ids of the contour objects that make up a text object. */
  textMembers(textId: number): number[] {
    return this.state.objects.filter((o) => o.textId === textId).map((o) => o.id);
  }

  /** Replace a text object's contours after its spec changed, keeping placement, layer and group. Returns the new ids. */
  retext(textId: number, spec: TextSpec, paths: Path[]): number[] {
    const members = this.state.objects.filter((o) => o.textId === textId);
    const first = members[0];
    if (!first) return [];
    const { matrix, layer } = first;
    const group = first.group ?? (paths.length > 1 ? this.state.nextGroup++ : undefined);
    this.remove(members.map((o) => o.id));
    this.state.texts[textId] = spec;
    return this.fillText(textId, paths, matrix, layer, group);
  }

  /** Convert text to plain paths: the contours stay, the editable text goes. */
  convertText(ids: Iterable<number>): void {
    const textIds = new Set(this.state.objects.filter((o) => new Set(this.expand(ids)).has(o.id) && o.textId !== undefined).map((o) => o.textId!));
    for (const o of this.state.objects) if (o.textId !== undefined && textIds.has(o.textId)) delete o.textId;
    for (const t of textIds) delete this.state.texts[t];
  }

  /** Snapshot of the given objects (whole groups, whole texts) for the clipboard. */
  copyOut(ids: Iterable<number>): ClipData {
    const want = new Set(this.expand(ids));
    for (const o of this.state.objects) if (o.textId !== undefined && this.state.objects.some((x) => want.has(x.id) && x.textId === o.textId)) want.add(o.id);
    const objects = this.state.objects.filter((o) => want.has(o.id)).map((o) => structuredClone({ path: o.path, matrix: o.matrix, layer: o.layer, group: o.group, textId: o.textId, settings: o.settings, tabs: o.tabs }));
    const texts: Record<number, TextSpec> = {};
    for (const o of objects) if (o.textId !== undefined && this.state.texts[o.textId]) texts[o.textId] = structuredClone(this.state.texts[o.textId]!);
    return { kerfSabre: 1, objects, texts };
  }

  /** Add clipboard shapes, moved by (dx, dy) mm, with fresh group and text ids. Returns the new object ids. */
  pasteIn(data: ClipData, dx: number, dy: number): number[] {
    const groups = new Map<number, number>();
    const texts = new Map<number, number>();
    return data.objects.map((c) => {
      const o = this.add(structuredClone(c.path), multiply(translation(dx, dy), c.matrix), c.layer);
      if (c.group !== undefined) {
        if (!groups.has(c.group)) groups.set(c.group, this.state.nextGroup++);
        o.group = groups.get(c.group);
      }
      if (c.textId !== undefined && data.texts[c.textId]) {
        if (!texts.has(c.textId)) { const id = this.state.nextText++; texts.set(c.textId, id); this.state.texts[id] = structuredClone(data.texts[c.textId]!); }
        o.textId = texts.get(c.textId);
      }
      if (c.settings) o.settings = { ...c.settings };
      if (c.tabs) o.tabs = { widthMm: c.tabs.widthMm, at: [...c.tabs.at] };
      return o.id;
    });
  }
}
