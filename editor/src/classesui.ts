// Teacher: classes, pupil IDs and PINs. A PIN is shown once, when it is made, and never again (the server only keeps a hash).
import { openClassWork, type TeacherCallbacks } from "./activitiesui";
import { btn, el, msg } from "./dom";
import { infoDialog, openDialog } from "./dialog";
import {
  addPupils, classPupils, createClass, listClasses, parseIds, pinsCsv, removePupil, resetPin,
  type ClassInfo, type ClassPupil, type Session,
} from "./server";

function download(name: string, text: string): void {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/csv" })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

/** The PINs that were just made: shown once, with copy and download. */
export function showPins(title: string, rows: { pupilId: string; pin: string }[], extra: string[] = []): Promise<void> {
  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "kdialog" });
    const table = el("table", { class: "pins" }, el("tr", {}, el("th", {}, "Pupil ID"), el("th", {}, "PIN")), ...rows.map((r) => el("tr", {}, el("td", {}, r.pupilId), el("td", {}, r.pin))));
    dlg.append(el("h2", {}, title), el("p", { class: "hint" }, "Write these down or download them now. They are not shown again (you can make a new PIN for a pupil any time)."), table, ...extra.map((x) => el("p", {}, x)));
    const copy = btn("Copy", () => void navigator.clipboard?.writeText(pinsCsv(rows)));
    const dl = btn("Download CSV", () => download("pins.csv", pinsCsv(rows)));
    const ok = btn("Done", () => dlg.close(), "on");
    dlg.append(el("div", { class: "krow" }, copy, dl, ok));
    document.body.append(dlg);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(); });
    dlg.showModal();
  });
}

function askIds(code: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "kdialog" });
    const ta = el("textarea", { rows: "8", placeholder: "P10234\nP10235\nP10236", spellcheck: "false", style: "width:100%;box-sizing:border-box" });
    dlg.append(el("h2", {}, `Add pupils to ${code}`), el("p", { class: "hint" }, "Paste pupil IDs (one per line, or separated by commas). IDs only, never names."), ta);
    let out: string[] | null = null;
    const go = btn("Add", () => { out = parseIds(ta.value); dlg.close(); }, "on");
    dlg.append(el("div", { class: "krow" }, btn("Cancel", () => dlg.close()), go));
    document.body.append(dlg);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(out && out.length ? out : null); });
    dlg.showModal();
    ta.focus();
  });
}

export function openClasses(session: Session, hooks: TeacherCallbacks, initialCode?: string): void {
  const dlg = el("dialog", { class: "kdialog teacher" });
  const body = el("div");
  dlg.append(el("h2", {}, "Classes and PINs"), body, el("div", { class: "krow" }, btn("Close", () => dlg.close())));
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();

  let open: { code: string; pupils: ClassPupil[] } | null = initialCode ? { code: initialCode, pupils: [] } : null;
  let classes: ClassInfo[] = [];
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { await infoDialog("That didn't work", [msg(e)]); } await load(); };

  async function load(): Promise<void> {
    classes = await listClasses(session);
    if (open) open = { code: open.code, pupils: await classPupils(session, open.code) };
    draw();
  }

  function draw(): void {
    if (!open) {
      const list = el("div", {}, el("h3", {}, `Classes (${classes.length})`));
      if (!classes.length) list.append(el("p", { class: "hint" }, "No classes yet. Create one, then add the pupil IDs."));
      for (const c of classes) list.append(el("div", { class: "filerow" }, el("span", {}, `${c.code}${c.label ? ` · ${c.label}` : ""} · ${c.pupilCount} pupil${c.pupilCount === 1 ? "" : "s"}`), btn("Open", () => void run(async () => { open = { code: c.code, pupils: [] }; }))));
      body.replaceChildren(list, btn("New class…", () => void (async () => {
        const v = await openDialog("New class", [{ key: "code", label: "Class code", type: "text", value: "", hint: "Letters, digits, - and _. Pupils type this to sign in" }, { key: "label", label: "Note (optional)", type: "text", value: "", hint: "For you, e.g. Y9 set 2. Not a pupil name" }], { ok: "Create" });
        if (v && String(v.code).trim()) await run(() => createClass(session, String(v.code).trim(), String(v.label).trim()));
      })(), "on"));
      return;
    }
    const code = open.code;
    const list = el("div", {}, el("h3", {}, `${code} (${open.pupils.length})`));
    if (!open.pupils.length) list.append(el("p", { class: "hint" }, "No pupils yet."));
    for (const p of open.pupils) {
      list.append(el("div", { class: "filerow" },
        el("span", {}, `${p.pupilId} · ${p.lastLogin ? `last signed in ${new Date(p.lastLogin).toLocaleString()}` : "never signed in"}${p.locked ? " · LOCKED" : ""}`),
        btn("New PIN", () => void run(async () => { const r = await resetPin(session, p.pupilId); await showPins("New PIN", [r]); })),
        btn("Remove", () => { if (confirm(`Remove ${p.pupilId} from ${code}? They will be signed out.`)) void run(() => removePupil(session, code, p.pupilId)); }, "danger")));
    }
    body.replaceChildren(list, el("div", { class: "krow" }, btn("‹ All classes", () => void run(async () => { open = null; })), btn("Activities and progress…", () => void openClassWork(session, code, hooks)), btn("Add pupils…", () => void (async () => {
      const ids = await askIds(code);
      if (!ids) return;
      await run(async () => {
        const r = await addPupils(session, code, ids);
        const notes = [...(r.existing.length ? [`Already in the class (PIN unchanged): ${r.existing.join(", ")}`] : []), ...(r.conflicts.length ? [`In another class, not added: ${r.conflicts.join(", ")}`] : [])];
        if (r.created.length) await showPins(`${r.created.length} pupil${r.created.length === 1 ? "" : "s"} added to ${code}`, r.created, notes);
        else await infoDialog("Nobody new to add", notes);
      });
    })(), "on")));
  }

  void load().catch(async (e) => { await infoDialog("Couldn't load classes", [msg(e)]); dlg.close(); });
}
