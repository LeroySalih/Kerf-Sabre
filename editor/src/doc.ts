// Document state with snapshot undo/redo. Edits change object matrices, never source geometry.
import { multiply, type Matrix, type Path } from "./geometry";

export type LayerType = "score" | "cut";

export interface DocObject {
  id: number;
  path: Path; // design space, never mutated after creation
  matrix: Matrix; // Design -> Bed
  layer: LayerType;
  /** Objects sharing a group id are selected and moved together. One level only. */
  group?: number;
}

export interface DocState {
  objects: DocObject[];
  nextId: number;
  nextGroup: number;
}

export class Doc {
  state: DocState = { objects: [], nextId: 1, nextGroup: 1 };
  private undoStack: DocState[] = [];
  private redoStack: DocState[] = [];

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
}
