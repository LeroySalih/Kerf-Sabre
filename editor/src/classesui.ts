// Teacher: classes (groups) and their pupils. Pupils sign in with DINO or with their Pupil Card (school code + group code + pupil ID +
// two-word password); the passwords are shown once, on printable cards (pupilcards.ts).
import { openClassWork, type TeacherCallbacks } from "./activitiesui";
import { btn, el, msg } from "./dom";
import { infoDialog, openDialog } from "./dialog";
import {
  addPupilsDetailed, classPupils, createClass, listClasses, mySchool, newPasswords, pupilLabel, removePupil, setPupilName,
  type ClassInfo, type ClassPupil, type Session,
} from "./server";
import { openCards, parsePupilLines, type Card, type PupilLine } from "./pupilcards";
import { decideJoinRequest, groupJoinRequests, waitingLabel, waitingText, type WaitingPupil } from "./joingroup";

function askPupils(code: string): Promise<{ pupils: PupilLine[]; generate: number } | null> {
  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "kdialog" });
    const ta = el("textarea", { rows: "8", placeholder: "Zoë Adams\nP10235, Ben Cole\nP10236", spellcheck: "false", style: "width:100%;box-sizing:border-box" }) as HTMLTextAreaElement;
    const count = el("input", { type: "number", min: "0", max: "500", value: "0", style: "width:6em" }) as HTMLInputElement;
    const err = el("p", { class: "hint", role: "alert" });
    dlg.append(el("h2", {}, `Add pupils to ${code}`),
      el("p", { class: "hint" }, "One pupil per line: a name (Kerf makes the pupil ID), an ID (e.g. their DINO ID), or ID, Name. You can paste two columns from a spreadsheet. Names are shown to staff and printed on the pupil's card, never anywhere else."),
      ta, el("p", {}, el("label", {}, "And make ", count, " more pupils with no names")), err);
    let out: { pupils: PupilLine[]; generate: number } | null = null;
    const go = btn("Add and make cards", () => {
      const r = parsePupilLines(ta.value);
      if (r.bad.length) { err.textContent = `These lines have an ID that is not letters, digits, - and _: ${r.bad.join("; ")}`; return; }
      out = { pupils: r.pupils, generate: Math.max(0, Math.min(500, Math.floor(Number(count.value) || 0))) };
      dlg.close();
    }, "on");
    dlg.append(el("div", { class: "krow" }, btn("Cancel", () => dlg.close()), go));
    document.body.append(dlg);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(out && (out.pupils.length || out.generate) ? out : null); });
    dlg.showModal();
    ta.focus();
  });
}

/** Opens the Pupil Cards for these new passwords (school code and group code from the server). */
async function printCards(session: Session, cls: ClassInfo | undefined, code: string, cards: Card[]): Promise<void> {
  if (!cards.length) return;
  const school = await mySchool(session);
  const opened = openCards({ schoolName: school.name, schoolCode: school.code ?? "", groupCode: cls?.joinCode ?? code, groupLabel: cls?.label,
    signInUrl: `${location.origin}/sign-in`, cards });
  if (!opened) await infoDialog("Allow pop-ups to print the cards", ["Your browser stopped the Pupil Cards opening in a new tab. Allow pop-ups for this site, then make new passwords again to print them."]);
}

export function openClasses(session: Session, hooks: TeacherCallbacks, initialCode?: string): void {
  const dlg = el("dialog", { class: "kdialog teacher" });
  const body = el("div");
  dlg.append(el("h2", {}, "Classes and pupils"), body, el("div", { class: "krow" }, btn("Close", () => dlg.close())));
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();

  let open: { code: string; pupils: ClassPupil[]; waiting: WaitingPupil[] } | null = initialCode ? { code: initialCode, pupils: [], waiting: [] } : null;
  let classes: ClassInfo[] = [];
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { await infoDialog("That didn't work", [msg(e)]); } await load(); };

  async function load(): Promise<void> {
    classes = await listClasses(session);
    if (open) {
      const [pupils, waiting] = await Promise.all([classPupils(session, open.code), groupJoinRequests(session, open.code).catch(() => [] as WaitingPupil[])]);
      open = { code: open.code, pupils, waiting };
    }
    draw();
  }

  function draw(): void {
    if (!open) {
      const list = el("div", {}, el("h3", {}, `Classes (${classes.length})`));
      if (!classes.length) list.append(el("p", { class: "hint" }, "No classes yet. Create one, then add the pupils' DINO IDs."));
      for (const c of classes) list.append(el("div", { class: "filerow" }, el("span", {}, `${c.code}${c.label ? ` · ${c.label}` : ""} · ${c.pupilCount} pupil${c.pupilCount === 1 ? "" : "s"}${c.joinRequests ? ` · ${waitingText(c.joinRequests)}` : ""}`), btn("Open", () => void run(async () => { open = { code: c.code, pupils: [], waiting: [] }; }))));
      body.replaceChildren(list, btn("New class…", () => void (async () => {
        const v = await openDialog("New class", [{ key: "code", label: "Class code", type: "text", value: "", hint: "Letters, digits, - and _" }, { key: "label", label: "Note (optional)", type: "text", value: "", hint: "For you, e.g. Y9 set 2. Not a pupil name" }], { ok: "Create" });
        if (v && String(v.code).trim()) await run(() => createClass(session, String(v.code).trim(), String(v.label).trim()));
      })(), "on"));
      return;
    }
    const code = open.code;
    const fromDino = classes.find((c) => c.code === code)?.source === "dino"; // its pupils sign in with DINO: no Pupil Cards or passwords
    const list = el("div", {});
    if (open.waiting.length) {
      // pupils who asked to join with the group code (shared 0.2.44): a teacher lets them in or says no
      list.append(el("h3", {}, `Waiting to join (${open.waiting.length})`),
        el("p", { class: "hint" }, "These pupils typed this group's code and asked to join. Approve only pupils you expect in this group."));
      for (const w of open.waiting) {
        list.append(el("div", { class: "filerow" },
          el("span", {}, `${waitingLabel(w)}${w.createdAt ? ` · asked ${new Date(w.createdAt).toLocaleString()}` : ""}${w.archived ? " · archived: approving brings them back" : ""}`),
          btn("Approve", () => void run(() => decideJoinRequest(session, code, w.id, true)), "on"),
          btn("Decline", () => void run(() => decideJoinRequest(session, code, w.id, false)), "danger")));
      }
    }
    list.append(el("h3", {}, `${code} (${open.pupils.length})`));
    if (fromDino) list.append(el("p", { class: "hint" }, "This group comes from DINO: its pupils, their names and the group's name follow the DINO class. Pupils sign in with DINO. To bring it up to date, use Sync with DINO on the Classes page."));
    if (!open.pupils.length) list.append(el("p", { class: "hint" }, "No pupils yet."));
    for (const p of open.pupils) {
      list.append(el("div", { class: "filerow" },
        el("span", {}, `${pupilLabel(p.pupilId, p.displayName)}${p.displayName ? ` (${p.pupilId})` : ""} · ${p.lastLogin ? `last signed in ${new Date(p.lastLogin).toLocaleString()}` : "never signed in"}${p.locked ? " · locked for a few minutes (too many wrong passwords)" : ""}`),
        ...(fromDino ? [] : [
        btn("Name…", () => void (async () => {
          const v = await openDialog(`Name for ${p.pupilId}`, [{ key: "name", label: "Name (optional)", type: "text", value: p.displayName ?? "", hint: "Shown to staff and printed on the pupil's card. Leave blank for none." }], { ok: "Save" });
          if (v) await run(() => setPupilName(session, code, p.pupilId, String(v.name ?? "").trim()));
        })()),
        btn("New password…", () => {
          if (!confirm(`Make a new password for ${pupilLabel(p.pupilId, p.displayName)}? Their old one stops working and they are signed out. You can print a new card.`)) return;
          void run(async () => printCards(session, classes.find((c) => c.code === code), code, await newPasswords(session, code, [p.pupilId])));
        }),
        btn("Remove", () => { if (confirm(`Remove ${pupilLabel(p.pupilId, p.displayName)} from ${code}? If this is their last group they are archived: signed out, files kept.`)) void run(() => removePupil(session, code, p.pupilId)); }, "danger")])));
    }
    body.replaceChildren(list, el("div", { class: "krow" }, btn("‹ All classes", () => void run(async () => { open = null; })), btn("Activities and progress…", () => void openClassWork(session, code, hooks)), ...(fromDino ? [] : [btn("New passwords and cards…", () => {
      if (!open?.pupils.length) return;
      if (!confirm(`Make new passwords for all ${open.pupils.length} pupils in ${code} and print their Pupil Cards? Their old passwords stop working and they are signed out.`)) return;
      void run(async () => printCards(session, classes.find((c) => c.code === code), code, await newPasswords(session, code)));
    })]), ...(fromDino ? [] : [btn("Add pupils…", () => void (async () => {
      const want = await askPupils(code);
      if (!want) return;
      await run(async () => {
        const r = await addPupilsDetailed(session, code, { pupils: want.pupils, generate: want.generate });
        if (!fromDino) await printCards(session, classes.find((c) => c.code === code), code, r.created.map((c) => ({ pupilId: c.pupilId, password: c.password ?? c.pin, displayName: c.displayName })));
        const notes = [...(r.created.length && !fromDino ? [`Their Pupil Cards opened in a new tab: print them now, the passwords are not shown again.`] : []), ...(r.restored?.length ? [`Brought back from the archive (files and password kept): ${r.restored.join(", ")}`] : []), ...(r.added?.length ? [`Also added (already in another group, password unchanged): ${r.added.join(", ")}`] : []), ...(r.existing.length ? [`Already in the class: ${r.existing.join(", ")}`] : []), ...(r.conflicts.length ? [`Used in another school, not added: ${r.conflicts.join(", ")}`] : [])];
        await infoDialog(r.created.length ? `${r.created.length} pupil${r.created.length === 1 ? "" : "s"} added to ${code}` : "Nobody new to add", notes);
      });
    })(), "on")])));
  }

  void load().catch(async (e) => { await infoDialog("Couldn't load classes", [msg(e)]); dlg.close(); });
}
