// Find a pupil's files quickly: filter the queue, waiting files, processed files and the Station queue by name and group.
// Pure, so the rules are tested (tests/queuefilter.test.ts); the bar itself is `filterBar` below (DOM).
import { el } from "./dom";

export interface PupilGroup { code: string; label?: string | null }
/** What a row needs to be filtered: a queue entry or a file summary both fit. */
export interface Filterable { pupilId?: string | null; pupilName?: string | null; pupilGroups?: PupilGroup[]; name?: string | null; ticket?: number | null; jobId?: string | null; id?: string }
export interface Filter { text: string; group: string }

export const EMPTY_FILTER: Filter = { text: "", group: "" };
const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Every word typed must appear in the pupil's name, ID, the file's name or its ticket/ID; the group (if picked) must be one of theirs. */
export function matches(row: Filterable, f: Filter): boolean {
  if (f.group && !(row.pupilGroups ?? []).some((g) => g.code === f.group)) return false;
  const words = fold(f.text).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold([row.pupilName, row.pupilId, row.name, row.ticket != null ? `#${row.ticket} ${row.ticket}` : "", row.jobId, row.id].filter(Boolean).join(" "));
  return words.every((w) => hay.includes(w));
}

export const applyFilter = <T extends Filterable>(rows: T[], f: Filter): T[] => rows.filter((r) => matches(r, f));

/** The groups that appear in these rows, for the group picker (sorted, each once). */
export function groupOptions(rows: Filterable[]): PupilGroup[] {
  const seen = new Map<string, PupilGroup>();
  for (const r of rows) for (const g of r.pupilGroups ?? []) if (!seen.has(g.code)) seen.set(g.code, g);
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export const isFiltering = (f: Filter): boolean => !!f.text.trim() || !!f.group;

/** "Showing 3 of 12" when filtering. */
export const countText = (shown: number, total: number, f: Filter): string => (isFiltering(f) ? `Showing ${shown} of ${total}` : "");

export type Focus = { on: "text"; start: number | null; end: number | null } | { on: "group" } | null;

export interface FilterBar {
  el: HTMLElement;
  get(): Filter;
  /** Refresh the group list from the rows now on show (keeps the choice) and the count. */
  update(rows: Filterable[], shown: number, total: number): void;
  /** Where the focus and caret are now: call before re-drawing a page that takes the bar out. */
  capture(): Focus;
  /** Put the bar (back) into a page, giving the focus and caret back if it had them. */
  attach(parent: HTMLElement, before?: Node | null, was?: Focus): void;
}

/** A search box and a group picker. `onChange` re-draws the list. The state is kept by `key` in sessionStorage. */
export function filterBar(onChange: (f: Filter) => void, key?: string): FilterBar {
  let f: Filter = { ...EMPTY_FILTER };
  try { if (key) f = { ...f, ...JSON.parse(sessionStorage.getItem(key) ?? "{}") }; } catch { /* fine */ }
  const text = el("input", { type: "search", placeholder: "Find a pupil, group or file…", "aria-label": "Find a pupil or file", class: "qf-text" }) as HTMLInputElement;
  text.value = f.text;
  const group = el("select", { "aria-label": "Group", class: "qf-group" }) as HTMLSelectElement;
  const count = el("span", { class: "hint qf-count" });
  const clear = el("button", { type: "button", class: "qf-clear", title: "Clear the filter" }, "Clear") as HTMLButtonElement;
  const save = () => { try { if (key) sessionStorage.setItem(key, JSON.stringify(f)); } catch { /* fine */ } };
  const changed = () => { f = { text: text.value, group: group.value }; save(); clear.hidden = !isFiltering(f); onChange(f); };
  text.addEventListener("input", changed);
  group.addEventListener("change", changed);
  clear.addEventListener("click", () => { text.value = ""; group.value = ""; changed(); text.focus(); });
  clear.hidden = !isFiltering(f);
  const bar = el("div", { class: "qf-bar" }, text, group, clear, count);
  return {
    el: bar,
    get: () => f,
    update(rows, shown, total) {
      const opts = groupOptions(rows);
      if (f.group && !opts.some((g) => g.code === f.group)) opts.push({ code: f.group });
      const want = [["", "All groups"], ...opts.map((g) => [g.code, g.label ? `${g.code} · ${g.label}` : g.code])];
      const have = [...group.options].map((o) => [o.value, o.text]);
      if (JSON.stringify(want) !== JSON.stringify(have)) group.replaceChildren(...want.map(([v, t]) => new Option(t, v)));
      group.value = f.group;
      count.textContent = countText(shown, total, f);
    },
    capture() {
      const a = document.activeElement;
      return a === text ? { on: "text", start: text.selectionStart, end: text.selectionEnd } : a === group ? { on: "group" } : null;
    },
    attach(parent, before = null, was) {
      const focus = was === undefined ? this.capture() : was;
      if (bar.parentNode !== parent || bar.nextSibling !== before) parent.insertBefore(bar, before);
      if (focus?.on === "text" && document.activeElement !== text) {
        text.focus();
        if (focus.start != null) text.setSelectionRange(focus.start, focus.end ?? focus.start);
      } else if (focus?.on === "group" && document.activeElement !== group) group.focus();
    },
  };
}
