// The Materials page's add/edit dialog (Admin site): a row of tabs at the top (Generic, then each laser), and the settings in rows:
// Material + thickness, Cut (power, speed, passes, air assist, kerf), Score (power, speed, passes, air assist), Sheet (width, height, cost).
// A laser's tab holds only what that laser does differently (blank = the Generic setting, shown greyed in the box).
// The rules and the preset it makes are in materialform.ts (tested); this file is only the form.
import { btn, el, msg } from "../dom";
import type { DialogValue } from "../dialog";
import { materialDraft, presetFromDraft, type MaterialDraft } from "../materialform";
import type { Preset } from "../presets";

type FieldSpec = { key: string; label: string; kind?: "number" | "text" | "air" | "air-same" | "tested"; wide?: boolean };

const CUT: FieldSpec[] = [{ key: "cutPower", label: "Power (%)" }, { key: "cutSpeed", label: "Speed (mm/s)" }, { key: "cutPasses", label: "Passes" }, { key: "cutAir", label: "Air assist", kind: "air" }];
const SCORE: FieldSpec[] = [{ key: "scorePower", label: "Power (%)" }, { key: "scoreSpeed", label: "Speed (mm/s)" }, { key: "scorePasses", label: "Passes" }, { key: "scoreAir", label: "Air assist", kind: "air" }];

function control(spec: FieldSpec, value: DialogValue, laser: string | null): HTMLInputElement | HTMLSelectElement {
  const id = `md-${laser ?? "generic"}-${spec.key}`;
  if (spec.kind === "air" || spec.kind === "air-same" || spec.kind === "tested") {
    const opts = spec.kind === "tested" ? [["yes", "Yes"], ["no", "Not yet"]] : laser ? [["", "Same as Generic"], ["yes", "On"], ["no", "Off"]] : [["yes", "On"], ["no", "Off"]];
    const s = el("select", { id, "data-key": spec.key }, ...opts.map(([v, t]) => new Option(t, v))) as HTMLSelectElement;
    s.value = String(value);
    return s;
  }
  const i = el("input", { id, "data-key": spec.key, type: "text", inputmode: spec.kind === "text" ? "text" : "decimal", autocomplete: "off" }) as HTMLInputElement;
  i.value = String(value ?? "");
  return i;
}

function field(spec: FieldSpec, value: DialogValue, laser: string | null): HTMLElement {
  const c = control(spec, value, laser);
  return el("div", { class: `md-field${spec.wide ? " wide" : ""}` }, el("label", { for: c.id }, spec.label), c);
}

const row = (title: string, ...fields: HTMLElement[]) => el("fieldset", { class: "md-row" }, el("legend", {}, title), el("div", { class: "md-fields" }, ...fields));

/** Opens the dialog. `save` is called with the finished preset; a refusal is shown in the dialog, which stays open. Resolves true once saved. */
export function openMaterialDialog(o: { title: string; intro?: string; cur?: Preset; copyOf?: Preset; stations: string[]; save: (p: Preset) => Promise<unknown> }): Promise<boolean> {
  const start = o.cur ?? o.copyOf;
  const draft: MaterialDraft = materialDraft(start, o.stations);
  if (o.copyOf && !o.cur) for (const st of o.stations) draft.lasers[st]!.tested = "no"; // a copy has not been test-gridded anywhere
  const isNew = !o.cur;

  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "kdialog md" }) as HTMLDialogElement;
    const g = draft.generic;
    const generic = el("div", { class: "md-panel", "data-tab": "", role: "tabpanel" },
      row("Material", field({ key: "material", label: "Material", kind: "text", wide: true }, g.material!, null), field({ key: "thicknessMm", label: "Thickness (mm)" }, g.thicknessMm!, null),
        ...(isNew ? [field({ key: "id", label: "ID (optional)", kind: "text" }, g.id ?? "", null)] : [])),
      row("Cut", ...CUT.map((f) => field(f, g[f.key]!, null)), field({ key: "kerfMm", label: "Kerf (mm)" }, g.kerfMm!, null)),
      row("Score", ...SCORE.map((f) => field(f, g[f.key]!, null))),
      row("Sheet", field({ key: "sheetW", label: "Width (mm)" }, g.sheetW!, null), field({ key: "sheetH", label: "Height (mm)" }, g.sheetH!, null), field({ key: "cost", label: "Cost (SAR, optional)", kind: "text" }, g.cost ?? "", null)),
      ...(isNew ? [el("p", { class: "hint" }, "Leave the ID blank to make one from the name and thickness, e.g. mdf-3mm. It cannot be changed later.")] : []));
    const lasers = o.stations.map((st) => {
      const v = draft.lasers[st]!;
      return el("div", { class: "md-panel", "data-tab": st, role: "tabpanel", hidden: "" },
        el("p", { class: "hint" }, `Fill in only what ${st} does differently from Generic. A blank box uses the Generic setting (shown in grey). Material, thickness and sheet are the same on every laser.`),
        row(`Cut on ${st}`, ...CUT.map((f) => field({ ...f, kind: f.kind === "air" ? "air-same" : f.kind }, v[f.key] ?? "", st)), field({ key: "kerf", label: "Kerf (mm)" }, v.kerf ?? "", st)),
        row(`Score on ${st}`, ...SCORE.map((f) => field({ ...f, kind: f.kind === "air" ? "air-same" : f.kind }, v[f.key] ?? "", st))),
        row("Test grid", field({ key: "tested", label: `Test-gridded on ${st}`, kind: "tested" }, v.tested ?? "no", st)));
    });
    const panels = [generic, ...lasers];

    // the grey hint in a laser's empty box is the Generic value, kept up to date while typing
    const genericValue = (key: string): string => (generic.querySelector<HTMLInputElement>(`[data-key="${key === "kerf" ? "kerfMm" : key}"]`)?.value ?? "");
    const refreshHints = () => { for (const p of lasers) for (const i of p.querySelectorAll<HTMLInputElement>("input[data-key]")) i.placeholder = genericValue(i.dataset.key!); };
    generic.addEventListener("input", refreshHints);
    refreshHints();

    const read = (panel: HTMLElement): Record<string, DialogValue> =>
      Object.fromEntries([...panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]")].map((c) => [c.dataset.key!, c.value]));
    const own = (panel: HTMLElement) => [...panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]")].some((c) => c.dataset.key !== "tested" && c.value.trim() !== "");

    const tabs = el("div", { class: "md-tabs", role: "tablist", "aria-label": "Settings for" });
    const tabButtons = ["", ...o.stations].map((st) => {
      const b = el("button", { type: "button", role: "tab", class: "md-tab", "data-tab": st }, st || "Generic") as HTMLButtonElement;
      b.addEventListener("click", () => show(st));
      return b;
    });
    tabs.append(el("span", { class: "md-tabs-label" }, "Settings for"), ...tabButtons);
    function show(st: string): void {
      for (const b of tabButtons) { const on = b.dataset.tab === st; b.setAttribute("aria-selected", String(on)); b.classList.toggle("on", on); }
      for (const p of panels) p.hidden = p.dataset.tab !== st;
    }
    const marks = () => { for (const b of tabButtons.slice(1)) b.classList.toggle("own", own(lasers[tabButtons.indexOf(b) - 1]!)); };
    for (const p of lasers) p.addEventListener("input", marks);
    for (const p of lasers) p.addEventListener("change", marks);
    marks();
    show("");

    const err = el("p", { class: "md-err", role: "alert" });
    let saved = false;
    const save = btn("Save", () => void (async () => {
      err.textContent = "";
      let p: Preset;
      try {
        p = presetFromDraft({ generic: read(generic), lasers: Object.fromEntries(lasers.map((l) => [l.dataset.tab!, read(l)])) }, o.cur);
      } catch (e) {
        const m = msg(e);
        const st = o.stations.find((x) => m.startsWith(`${x}: `));
        show(st ?? "");
        err.textContent = m;
        return;
      }
      save.disabled = true;
      try { await o.save(p); saved = true; dlg.close(); } catch (e) { err.textContent = msg(e); } finally { save.disabled = false; }
    })(), "on");
    dlg.append(el("h2", {}, o.title), ...(o.intro ? [el("p", { class: "hint" }, o.intro)] : []), ...(o.stations.length ? [tabs] : []), ...panels, err,
      el("div", { class: "krow" }, btn("Cancel", () => dlg.close()), save));
    document.body.append(dlg);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(saved); });
    dlg.showModal();
    generic.querySelector<HTMLInputElement>("input")?.focus();
  });
}
