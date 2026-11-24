// Ticking several files on the Queue page and acting on them together (cancel, change material). Pure: tested in
// tests/queueselect.test.ts; the page is `mountQueue` in stationui.ts.

/** Drop ticked files that are no longer on the page (cut, cancelled, or moved on by someone else). */
export function prune(selected: Set<string>, onPage: Iterable<string>): Set<string> {
  const keep = new Set(onPage);
  return new Set([...selected].filter((id) => keep.has(id)));
}

/** Tick or untick every file shown (e.g. the ones the filter left): ticks them all unless they already all are. */
export function toggleAll(selected: Set<string>, shown: string[]): Set<string> {
  const all = shown.length > 0 && shown.every((id) => selected.has(id));
  const out = new Set(selected);
  for (const id of shown) { if (all) out.delete(id); else out.add(id); }
  return out;
}

export interface BulkResult { done: string[]; failed: { id: string; message: string }[] }

/** Run `fn` on each file in turn (never all at once: the server checks each one), collecting what went wrong. */
export async function runEach(ids: string[], fn: (id: string) => Promise<unknown>, onProgress?: (done: number, total: number) => void): Promise<BulkResult> {
  const out: BulkResult = { done: [], failed: [] };
  for (const [i, id] of ids.entries()) {
    try { await fn(id); out.done.push(id); } catch (e) { out.failed.push({ id, message: e instanceof Error ? e.message : String(e) }); }
    onProgress?.(i + 1, ids.length);
  }
  return out;
}

/** "3 files cancelled." / "2 files changed to MDF 3 mm; 1 could not be: …" */
export function bulkText(r: BulkResult, verb: string, label: (id: string) => string = (id) => id): string[] {
  const n = r.done.length;
  const lines = [n ? `${n} file${n === 1 ? "" : "s"} ${verb}.` : `No files were ${verb}.`];
  for (const f of r.failed) lines.push(`${label(f.id)}: ${f.message}`);
  return lines;
}
