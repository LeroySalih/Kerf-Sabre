// The pages of the admin site. Each page draws itself into a host element and may return a function that stops its refreshing.
import { openClasses } from "../classesui";
import { waitingText } from "../joingroup";
import { openClassWork } from "../activitiesui";
import { infoDialog, openDialog, type DialogValue } from "../dialog";
import { profileFromForm, stationFields } from "../machineform";
import { opText } from "../materialform";
import { openMaterialDialog } from "./materialdialog";
import { presetLabel, type Preset } from "../presets";
import { checkSchoolName } from "./schoolname";
import { termsFields, termsFromForm, termsText, type Terms } from "../termsform";
import { applyFilter, filterBar } from "../queuefilter";
import { btn, el, fillWindow, modal, msg, shortDate } from "../dom";
import { mountQueue } from "../stationui";
import { previewSvg } from "../stationlogic";
import {
  addStaff, classActivities, classPupils, controlStation, disconnectStation, cutterCommand, cutterKinds, deleteMachine, getMachineDoc, listMachines, makeCutterPackage, putMachine, createClass, createSchool, mySchool, setAutoApprove, renameSchool, listPresets, createPreset, putPreset, describeDuration, listClasses, listQueue, listSchools, listStaff, listStations,
  listJobsByStatus, pupilLabel, requeueJob, updateSchool, getSignIn, setSignIn, type SignInSettings, getDefaultTerms, setDefaultTerms, listStaffPeople, inviteStaff, removeStaffPerson, listDinoClasses, importDinoClasses, syncDinoClass, archivedPupils, deletePupilForever, getSchoolTerms, setSchoolTerms, myTerms, isPaid, hasActivities, deletePreset, STATUS_TEXT, removePupil, revokeStaff, updateClass,
  type Activity, type CutterKind, type JobSummary, type Session, type StationInfo,
} from "../server";

export interface Ctx { session: Session; school: string; go: (key: string) => void; /** The school has a new name: the Admin header shows it at once. */ renamed?: (name: string) => void }
export interface Page { key: string; title: string; lead: string; mount: (host: HTMLElement, ctx: Ctx) => void | (() => void) }

const fail = (host: HTMLElement, e: unknown) => host.replaceChildren(el("p", { class: "ad-err" }, msg(e)));
const empty = (text: string) => el("div", { class: "ad-empty" }, text);
const th = (...names: string[]) => el("tr", {}, ...names.map((n) => el("th", {}, n)));
const table = (head: string[], rows: HTMLElement[]) => el("table", { class: "ad-table" }, th(...head), ...rows);
const cell = (...k: (string | Node)[]) => el("td", {}, ...k);
const actions = (...k: Node[]) => el("td", { class: "actions" }, el("div", {}, ...k));
const bullets = (items: string[]) => items.map((t) => el("p", { class: "ad-li" }, "• " + t.replace(/<([^>]+)>/g, "$1")));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Run an action; a failure is told to the person, and the page redraws either way. */
const attempt = async (fn: () => Promise<unknown>, redraw: () => void) => { try { await fn(); } catch (e) { await infoDialog("That didn't work", [msg(e)]); } redraw(); };

/** A refreshing page: `draw` runs now and every `ms` until the page is left. */
function refreshing(host: HTMLElement, draw: () => Promise<void>, ms: number): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try { await draw(); } catch (e) { fail(host, e); } finally { busy = false; }
    if (!stopped) timer = setTimeout(() => void tick(), ms);
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}

/** Shown once: a token that is not stored anywhere in the clear. */
async function showToken(title: string, who: string, token: string, note: string): Promise<void> {
  const { dlg, show } = modal("kdialog");
  dlg.append(el("h2", {}, title), el("p", {}, who), el("div", { class: "ad-token" }, token), el("p", { class: "hint" }, note),
    el("div", { class: "krow" }, btn("Copy", () => void navigator.clipboard?.writeText(token)), btn("Done", () => dlg.close(), "on")));
  await show();
}

/** What the Editor's "open a pupil's file" did, as a look-only preview: this site is not an editor. */
const lookAtFile = (j: JobSummary) => {
  const { dlg, show } = modal("kdialog");
  const view = el("div", { class: "st-preview" });
  view.innerHTML = previewSvg(j.objects);
  dlg.append(el("h2", {}, `${pupilLabel(j.pupilId, j.pupilName) || "Pupil"}: ${j.id}`), view,
    el("p", { class: "hint" }, `${j.preset.id} · ${j.status}${j.estimate?.durationS ? ` · ${describeDuration(j.estimate.durationS)}` : ""}`), el("div", { class: "krow" }, btn("Close", () => dlg.close())));
  void show();
};

// ---------------------------------------------------------------- overview

const overview: Page = {
  key: "overview", title: "Overview", lead: "What is happening right now.",
  mount(host, ctx) {
    return refreshing(host, async () => {
      const [classes, waiting, queue, stations] = await Promise.all([listClasses(ctx.session), listJobsByStatus(ctx.session, "submitted"), listQueue(ctx.session), listStations(ctx.session)]);
      const online = stations.filter((s) => s.online).length;
      const card = (n: number | string, label: string, go: string, alert = false) =>
        el("div", { class: "ad-card", tabindex: "0", role: "link" }, el("div", { class: `num${alert ? " alert" : ""}` }, String(n)), label);
      const cards = el("div", { class: "ad-cards" },
        card(waiting.length, "files waiting for approval", "queue", waiting.length > 0), card(queue.length, "in the queue or cutting", "queue"),
        card(`${online}/${stations.length}`, "stations online", "stations"), card(classes.length, "classes", "classes"),
        card(classes.reduce((n, c) => n + c.pupilCount, 0), "pupils", "pupils"));
      [...cards.children].forEach((c, i) => { const to = ["queue", "queue", "stations", "classes", "pupils"][i]!; c.addEventListener("click", () => ctx.go(to)); });
      host.replaceChildren(cards, ...(waiting.length ? [el("p", {}, btn(`Review ${plural(waiting.length, "file")}`, () => ctx.go("queue"), "on"))] : []));
    }, 5000);
  },
};

// ---------------------------------------------------------------- classes

const APPROVAL = [{ v: "yes", text: "A teacher approves each file" }, { v: "no", text: "Straight to the queue" }];

const classes: Page = {
  key: "classes", title: "Classes", lead: "Each class (group) has its own join code, pupils and activities. A pupil can be in several groups. Rename a group when it moves up a year, or archive it.",
  mount(host, ctx) {
    const s = ctx.session;
    let showArchived = false;
    const draw = async () => {
      const list = await listClasses(s, undefined, showArchived);
      const redraw = () => void draw().catch((e) => fail(host, e));
      const laserLimit = s.limits?.laserGroups ?? null;
      const pickLaser = isPaid(s) && laserLimit != null && s.role === "admin";
      const bar = el("div", { class: "ad-bar" }, btn("New class…", () => void (async () => {
        const v = await openDialog("New class", [
          { key: "code", label: "Class code (optional)", type: "text", value: "", hint: "Letters, digits, - and _. Leave blank and Kerf makes one. Pupils type it to sign in" },
          { key: "label", label: "Note (optional)", type: "text", value: "", hint: "For you, e.g. Year 9 set 2. Not a pupil name" },
          ...(isPaid(s) ? [{ key: "approval", label: "Files from this class", type: "select" as const, value: "yes", options: APPROVAL.map((a) => ({ value: a.v, label: a.text })) }] : []),
        ], { ok: "Create" });
        if (v) await attempt(() => createClass(s, String(v.code ?? "").trim(), String(v.label ?? "").trim(), v.approval !== "no"), redraw);
      })(), "on"), ...(s.sso ? [btn("Import from DINO…", () => void importFromDino(s, redraw))] : []),
      btn(showArchived ? "Show current classes" : "Show archived classes", () => { showArchived = !showArchived; redraw(); }));
      if (!list.length) return host.replaceChildren(bar, empty(showArchived ? "No archived classes." : "No classes yet. Create one, then add the pupils' IDs."));
      const head = ["Class", "Join code", "Note", "Teacher", "Pupils", ...(isPaid(s) ? ["Files from this class"] : []), ...(pickLaser ? ["Laser group"] : []), ""];
      host.replaceChildren(bar, table(head, list.map((c) => {
        const sel = el("select", { "aria-label": `Approval for ${c.code}` }, ...APPROVAL.map((a) => new Option(a.text, a.v)));
        sel.value = c.requireApproval === false ? "no" : "yes";
        sel.addEventListener("change", () => void attempt(() => updateClass(s, c.code, { requireApproval: sel.value !== "no" }), redraw));
        const laser = el("input", { type: "checkbox", "aria-label": `Laser group ${c.code}` }) as HTMLInputElement;
        laser.checked = !!c.laser;
        laser.addEventListener("change", () => void attempt(() => updateClass(s, c.code, { laser: laser.checked }), redraw));
        const fromDino = c.source === "dino";
        const edit = btn("Edit…", () => void (async () => {
          const v = await openDialog(`Class ${c.code}`, [
            { key: "label", label: "Note", type: "text", value: c.label ?? "", hint: "e.g. Year 10 set 2 after moving up a year" },
            // a group from DINO has no join code: its pupils come from DINO
            ...(fromDino ? [] : [{ key: "joinCode", label: "Join code", type: "text" as const, value: c.joinCode ?? c.code, hint: "What pupils type to sign in. Unique in your school" }]),
          ], { ok: "Save" });
          if (v) await attempt(() => updateClass(s, c.code, { label: String(v.label ?? "").trim(), ...(fromDino ? {} : { joinCode: String(v.joinCode ?? "").trim() || c.code }) }), redraw);
        })());
        // the join code column: a DINO group is kept in step with DINO instead of being joined by code
        const join = fromDino
          ? (s.sso ? btn("Sync with DINO…", () => void syncWithDino(s, c.code, redraw)) : el("span", { class: "hint", title: "Sign in with DINO to sync it" }, "From DINO"))
          : el("code", {}, c.joinCode ?? c.code);
        const archive = btn(c.archived ? "Bring back" : "Archive", () => {
          if (!c.archived && !confirm(`Archive ${c.code}? Its pupils can no longer sign in through it; their files and work are kept.`)) return;
          void attempt(() => updateClass(s, c.code, { archived: !c.archived }), redraw);
        });
        return el("tr", {}, cell(el("b", {}, c.code)), cell(join), cell(c.label ?? ""), cell(c.teacherId ? el("span", { title: c.teacherId }, c.teacherName ?? c.teacherId) : "shared"), cell(String(c.pupilCount), ...(c.joinRequests ? [" ", el("span", { class: "st-dot wait", title: "Open Pupils… to let them in" }, waitingText(c.joinRequests))] : [])),
          ...(isPaid(s) ? [cell(sel)] : []), ...(pickLaser ? [cell(laser)] : []),
          actions(btn("Pupils…", () => openClasses(s, { openFile: lookAtFile }, c.code)),
            ...(hasActivities(s) ? [btn("Activities…", () => void openClassWork(s, c.code, { openFile: lookAtFile }, "activities")), btn("Progress…", () => void openClassWork(s, c.code, { openFile: lookAtFile }, "progress"))] : []),
            ...(fromDino ? [] : [edit]), archive));
      })), ...(isPaid(s) ? [el("p", { class: "hint" }, "Changing the approval setting only affects files sent from now on. Files already waiting stay as they are.")] : []),
      ...(pickLaser ? [el("p", { class: "hint" }, `Your plan lets up to ${laserLimit} class${laserLimit === 1 ? "" : "es"} send files to the laser. Tick them under "Laser group".`)] : []));
    };
    void draw().catch((e) => fail(host, e));
  },
};

/** Tick the teacher's DINO classes to make Kerf groups of them (with their pupils' DINO IDs). */
async function importFromDino(s: Session, done: () => void): Promise<void> {
  let list;
  try { list = await listDinoClasses(s); } catch (e) { await infoDialog("Couldn't get your DINO classes", [msg(e)]); return; }
  if (!list.length) { await infoDialog("No DINO classes", ["DINO does not list any classes that you teach."]); return; }
  const dlg = el("dialog", { class: "kdialog" });
  const boxes: [HTMLInputElement, string][] = [];
  const rows = list.map((g) => {
    const box = el("input", { type: "checkbox", "aria-label": `Import ${g.name}` }) as HTMLInputElement;
    if (g.importedAs) box.disabled = true; else boxes.push([box, g.id]);
    const what = [g.subject, g.yearGroup ? `Year ${g.yearGroup}` : null, `${g.pupilCount} pupil${g.pupilCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
    return el("label", { class: "filerow", style: "cursor:pointer" }, box, " ", el("b", {}, g.name), el("span", { class: "hint" }, ` ${what}`),
      ...(g.importedAs ? [el("span", { class: "hint" }, ` · already imported as ${g.importedAs}${g.archived ? " (archived)" : ""}: use Sync with DINO`)] : []));
  });
  let chosen: string[] = [];
  dlg.append(el("h2", {}, "Import classes from DINO"),
    el("p", { class: "hint" }, "Each class you tick becomes a group in Kerf with its pupils' DINO IDs. Pupils sign in with DINO. Their names appear once they have signed in to Kerf. You can sync a group with DINO later."),
    el("div", {}, ...rows),
    el("div", { class: "krow" }, btn("Cancel", () => dlg.close()), btn("Import", () => { chosen = boxes.filter(([b]) => b.checked).map(([, id]) => id); dlg.close(); }, "on")));
  document.body.append(dlg);
  await new Promise<void>((resolve) => { dlg.addEventListener("close", () => { dlg.remove(); resolve(); }); dlg.showModal(); });
  if (!chosen.length) return;
  await attempt(async () => {
    const r = await importDinoClasses(s, chosen);
    await infoDialog("Imported from DINO", r.map((x) => x.already ? `${x.name}: already imported as ${x.code}` : `${x.name}: group ${x.code} with ${x.pupils ?? 0} pupil${x.pupils === 1 ? "" : "s"}${x.conflicts?.length ? ` (not added, used in another school: ${x.conflicts.join(", ")})` : ""}`));
  }, done);
}

/** Show what syncing a DINO-imported group would change, and make the changes only if the teacher says so. */
async function syncWithDino(s: Session, code: string, done: () => void): Promise<void> {
  let p;
  try { p = await syncDinoClass(s, code, false); } catch (e) { await infoDialog("Couldn't compare with DINO", [msg(e)]); return; }
  if (!p.add.length && !p.remove.length) { await infoDialog(`${code} matches DINO`, [`Everyone in the DINO class ${p.name} is in this group, and nobody else.`]); return; }
  const lines = [...(p.add.length ? [`Add ${p.add.length}: ${p.add.join(", ")}`] : []),
    ...(p.remove.length ? [`Remove ${p.remove.length} from this group: ${p.remove.join(", ")}. Their accounts and files are kept (a pupil in no other group is archived).`] : [])];
  if (!confirm(`Sync ${code} with the DINO class ${p.name}?\n\n${lines.join("\n\n")}`)) return;
  await attempt(async () => {
    const r = await syncDinoClass(s, code, true);
    await infoDialog(`${code} synced with DINO`, [`${r.add.length} added, ${r.remove.length} removed.`, ...(r.conflicts?.length ? [`Not added (used in another school): ${r.conflicts.join(", ")}`] : [])]);
  }, done);
}

// ---------------------------------------------------------------- pupils

const pupils: Page = {
  key: "pupils", title: "Pupils", lead: "Every pupil in the school, by class. Pupil IDs (their DINO IDs) only, never names.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const [cls, gone] = await Promise.all([listClasses(s), archivedPupils(s).catch(() => [])]);
      const all = await Promise.all(cls.map(async (c) => ({ c, rows: await classPupils(s, c.code) })));
      const redraw = () => void draw().catch((e) => fail(host, e));
      const rows: HTMLElement[] = [];
      for (const { c, rows: ps } of all) for (const p of ps) {
        rows.push(el("tr", {}, cell(el("b", {}, pupilLabel(p.pupilId, p.displayName))), cell(c.code), cell(p.lastLogin ? new Date(p.lastLogin).toLocaleString() : "never"),
          actions(...(c.source === "dino" ? [] : [btn("Remove", () => { if (confirm(`Remove ${pupilLabel(p.pupilId, p.displayName)} from ${c.code}? If this is their last group they are archived: signed out, files kept.`)) void attempt(() => removePupil(s, c.code, p.pupilId), redraw); }, "danger")]))));
      }
      const archived = gone.map((p) => el("tr", {}, cell(el("b", {}, pupilLabel(p.pupilId, p.displayName))), cell(p.lastGroup), cell(new Date(p.archivedAt).toLocaleDateString()),
        actions(...(s.role === "admin" ? [btn("Delete for good…", () => {
          const who = pupilLabel(p.pupilId, p.displayName);
          if (prompt(`Delete ${who} for good? Their account, files and work are removed and cannot be brought back. This is logged. Type the pupil ID to confirm.`) !== p.pupilId) return;
          void attempt(async () => { const r = await deletePupilForever(s, p.pupilId); await infoDialog("Deleted", [`${who} and ${r.filesDeleted} file${r.filesDeleted === 1 ? "" : "s"} were deleted.`]); }, redraw);
        }, "danger")] : []))));
      const waiting = cls.reduce((n, c) => n + (c.joinRequests ?? 0), 0);
      host.replaceChildren(...(waiting ? [el("p", { class: "ad-warn" }, `${waitingText(waiting)} a class. Open the class on the Classes page (Pupils…) to approve or decline.`)] : []),
        ...(rows.length ? [table(["Pupil ID", "Class", "Last signed in", ""], rows)] : [empty(cls.length ? "No pupils yet. Open a class and add pupils' DINO IDs." : "No classes yet.")]),
        ...(cls.length ? [el("p", { class: "hint" }, "To add pupils, open the class on the Classes page.")] : []),
        ...(archived.length ? [el("h2", {}, "Archived pupils"), el("p", { class: "hint" }, "Out of every group: they cannot sign in, and their files are kept. Add a pupil to a group to bring them back." + (s.role === "admin" ? " Only a school admin can delete one for good." : "")),
          table(["Pupil ID", "Last group", "Archived", ""], archived)] : []));
    };
    void draw().catch((e) => fail(host, e));
  },
};

// ---------------------------------------------------------------- activities

const activities: Page = {
  key: "activities", title: "Activities", lead: "What each class has been set. Open a class to add, edit, publish or reorder activities, see progress and give feedback.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const cls = await listClasses(s);
      const all = await Promise.all(cls.map(async (c) => ({ c, acts: await classActivities(s, c.code) })));
      const redraw = () => void draw().catch((e) => fail(host, e));
      if (!cls.length) return host.replaceChildren(empty("No classes yet."));
      host.replaceChildren(...all.map(({ c, acts }) => {
        const stats = (a: Activity) => { const n = a.counts ?? {}; return [n.submitted ? `${n.submitted} handed in` : "", n.revise ? `${n.revise} to improve` : "", n.complete ? `${n.complete} complete` : "", n.working ? `${n.working} working` : ""].filter(Boolean).join(", "); };
        const open = (start: "activities" | "progress") => void openClassWork(s, c.code, { openFile: lookAtFile }, start).then(redraw);
        return el("section", { class: "ad-class" }, el("h2", {}, c.code, el("span", { class: "hint" }, `${c.label ? c.label + " · " : ""}${plural(c.pupilCount, "pupil")}`)),
          acts.length ? table(["#", "Activity", "Shown to pupils", "Due", "Progress"], acts.map((a, i) => el("tr", {}, cell(String(i + 1)), cell(el("b", {}, a.title)),
            cell(el("span", { class: `ad-tag ${a.published ? "ok" : "warn"}` }, a.published ? "visible" : "hidden")), cell(shortDate(a.dueAt)), cell(stats(a))))) : empty("Nothing set for this class yet."),
          el("div", { class: "ad-bar", style: "margin-top:8px" }, btn("Manage activities…", () => open("activities"), "on"), btn("Progress and feedback…", () => open("progress"))));
      }));
    };
    void draw().catch((e) => fail(host, e));
  },
};

// ---------------------------------------------------------------- queue

const queue: Page = {
  key: "queue", title: "Queue", lead: "Approve or reject files, and put the queue in order. This updates by itself every few seconds.",
  mount(host, ctx) {
    const s = ctx.session;
    const box = el("input", { type: "checkbox", "aria-describedby": "aa-hint" }) as HTMLInputElement;
    const hint = el("span", { class: "hint", id: "aa-hint" }, "");
    const explain = () => { hint.textContent = box.checked ? "On: every new file goes straight to the queue. Files already waiting still need you." : "Off: files wait here for approval (unless their class is set to go straight to the queue)."; };
    box.disabled = true;
    void mySchool(s).then((sc) => { box.checked = sc.autoApprove !== false; box.disabled = false; explain(); }).catch(() => { hint.textContent = "Could not read the auto-approve setting."; });
    box.addEventListener("change", () => {
      const want = box.checked;
      box.disabled = true;
      void setAutoApprove(s, want).then((sc) => { box.checked = sc.autoApprove !== false; })
        .catch(async (e) => { box.checked = !want; await infoDialog("That didn't work", [msg(e)]); })
        .finally(() => { box.disabled = false; explain(); });
    });
    const bar = el("div", { class: "ad-bar" }, el("label", {}, box, " Auto-approve new files"), hint);
    // Two tabs: the live queue, and the files already processed (cut, failed, cancelled or rejected), which can go back to the queue.
    const tabs = el("div", { class: "ad-tabs", role: "tablist" });
    const body = el("div");
    let stop: () => void = () => {};
    let current: "queue" | "processed" = "queue";
    try { if (sessionStorage.getItem("kerf.admin.queueTab") === "processed") current = "processed"; } catch { /* fine */ }
    const show = (which: "queue" | "processed") => {
      stop();
      current = which;
      try { sessionStorage.setItem("kerf.admin.queueTab", which); } catch { /* fine */ }
      tabs.replaceChildren(...([["queue", "Queue"], ["processed", "Processed files"]] as const).map(([k, label]) => {
        const b = btn(label, () => show(k), k === current ? "on" : "");
        b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(k === current));
        return b;
      }));
      if (which === "queue") { host.replaceChildren(tabs, bar, body); stop = mountQueue(body, s); }
      else { host.replaceChildren(tabs, body); stop = mountProcessed(body, s); }
    };
    show(current);
    return () => stop();
  },
};

const PROCESSED = "done,failed,cancelled";

/** Files that have left the queue: cut, failed, cancelled or rejected (newest first). Any of them can go back to the end of the queue. */
function mountProcessed(host: HTMLElement, s: Session): () => void {
  let jobs: JobSummary[] = [];
  let materials: Preset[] = [];
  const bar = filterBar(() => show(), "kerf.admin.processedFilter");
  const body = el("div");
  host.replaceChildren(bar.el, body); // the bar stays put (and keeps its focus) while the list refreshes
  const fill = fillWindow(body, 24, 240); // the list fills the window and scrolls inside it
  const mat = (id: string) => { const p = materials.find((m) => m.id === id); return p ? presetLabel(p) : `${id} (removed)`; };
  const redraw = () => void draw().catch((e) => fail(body, e));
  function show(): void {
    const rows = applyFilter(jobs, bar.get());
    bar.update(jobs, rows.length, jobs.length);
    if (!jobs.length) return void body.replaceChildren(empty("Nothing has been processed yet."));
    if (!rows.length) return void body.replaceChildren(empty("No processed files match the filter."));
    body.replaceChildren(table(["Sent", "Pupil", "Groups", "File", "Material", "Result", ""], rows.map((j) => el("tr", {},
      cell(shortDate(j.createdAt)), cell(pupilLabel(j.pupilId, j.pupilName)), cell((j.pupilGroups ?? []).map((g) => g.code).join(", ")),
      cell(el("span", { title: j.id }, j.name || (j.ticket ? `Ticket ${j.ticket}` : j.id))),
      cell(mat(j.preset.id)),
      cell(el("span", { class: `ad-tag ${j.status === "done" ? "ok" : "warn"}` }, STATUS_TEXT[j.status] ?? j.status), ...(j.statusReason ? [el("div", { class: "hint" }, j.statusReason)] : [])),
      actions(btn("Back to the queue", () => { if (confirm("Put this file back at the end of the queue?")) void attempt(() => requeueJob(s, j.id), redraw); }))))),
      el("p", { class: "hint" }, "The newest 200. A file put back gets a new ticket at the end of the queue, already approved."));
    fill.fit();
  }
  const draw = async (): Promise<void> => {
    [jobs, materials] = await Promise.all([listJobsByStatus(s, PROCESSED, undefined, 200), listPresets(s)]);
    show();
  };
  const stop = refreshing(body, draw, 10000);
  return () => { stop(); fill.stop(); };
}

// ---------------------------------------------------------------- materials (power, speed, passes, kerf; per-laser settings)

const materials: Page = {
  key: "materials", title: "Materials", lead: "Each material's laser settings: power, speed and passes for Cut and Score, and the kerf. In Edit…, the Generic tab holds the usual settings and each laser's tab what that laser does differently. Every change is a new version: files already sent keep the settings they were sent with.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const [list, stations] = await Promise.all([listPresets(s), listStations(s)]);
      const redraw = () => void draw().catch((e) => fail(host, e));
      // one dialog for the material and its settings on each laser (tabs: Generic, then each station)
      const edit = async (cur?: Preset, copyOf?: Preset) => {
        const done = await openMaterialDialog({
          title: cur ? `Edit ${presetLabel(cur)}` : copyOf ? `Copy of ${presetLabel(copyOf)}` : "New material",
          intro: cur ? "Saving makes a new version. Files already sent keep the settings they were sent with." : undefined,
          cur, copyOf, stations: stations.map((x) => x.id).sort(),
          save: (p) => (cur ? putPreset(s, p) : createPreset(s, p)),
        });
        if (done) redraw();
      };
      const bar = el("div", { class: "ad-bar" }, btn("New material", () => void edit(), "on"));
      if (!list.length) return host.replaceChildren(bar, empty("No materials yet."));
      host.replaceChildren(bar, table(["Material", "Kerf", "Cut", "Score", ""], list.map((p) => el("tr", {},
        cell(el("b", {}, presetLabel(p)), el("div", { class: "hint" }, `${p.id} · v${p.version}`)),
        cell(`${p.kerfMm} mm`), cell(opText(p.cut)), cell(opText(p.score)),
        actions(btn("Edit…", () => void edit(p)), btn("Copy…", () => void edit(undefined, p)),
          btn("Delete", () => { if (confirm(`Delete ${presetLabel(p)}? Pupils can no longer choose it. Files already cut keep their settings.`)) void attempt(() => deletePreset(s, p.id), redraw); }, "danger"))))),
        el("p", { class: "hint" }, "Pupils pick the material in the Editor; the laser uses that material's settings, with the laser's own settings where it has them. Power is a percentage of the laser's maximum ($30). A material that files in the queue still use cannot be deleted: change their material on the Queue page first."));
    };
    void draw().catch((e) => fail(host, e));
  },
};

// ---------------------------------------------------------------- stations (the lasers, and the Cutter software that runs on each laser's PC)

/** Add a station (no `cur`) or change one. Opens the form, then saves the profile. Resolves true if something was saved. */
async function stationForm(s: Session, cur?: Record<string, unknown>): Promise<boolean> {
  let typed: Record<string, DialogValue> | null = null;
  for (;;) {
    const fields = stationFields(cur as never).map((f) => (typed && f.key in typed ? { ...f, value: typed[f.key]! } : f));
    const v = await openDialog(cur ? `Edit ${String(cur.id)}` : "Add a station", fields, { ok: "Save", intro: cur ? "The Cutter reads the laser's real settings when it connects." : "A station is one laser and the PC that runs it. You can get its Cutter software once it is saved." });
    if (!v) return false;
    try {
      await putMachine(s, profileFromForm(v, cur));
      return true;
    } catch (e) {
      await infoDialog("That didn't work", [msg(e)]);
      typed = v; // a mistake does not mean typing it all again
    }
  }
}

/** The download and the command that starts the Cutter on one station's PC. School admins only. */
async function cutterSoftware(s: Session, station: string): Promise<void> {
  let kinds;
  try { kinds = await cutterKinds(s); } catch (e) { await infoDialog("That didn't work", [msg(e)]); return; }
  const { dlg, show } = modal("kdialog");
  const kind = el("select", { "aria-label": "Which Cutter" },
    new Option("Practice Cutter: behaves like a laser, cuts nothing", "practice"),
    new Option(kinds["creality-falcon"].available ? "Creality Falcon Cutter: runs a Creality Falcon laser from a Windows PC" : "Creality Falcon Cutter (not built on this server yet)", "creality-falcon")) as HTMLSelectElement;
  (kind.options[1] as HTMLOptionElement).disabled = !kinds["creality-falcon"].available;
  const url = el("input", { type: "text", value: s.baseUrl || location.origin, "aria-label": "Server address", style: "min-width:22em" }) as HTMLInputElement;
  const out = el("div");
  const row = (label: string, cmd: string) => el("div", { class: "ad-cmd" }, el("div", { class: "hint" }, label), el("div", { class: "ad-token" }, cmd), btn("Copy", () => void navigator.clipboard?.writeText(cmd)));
  const go = btn("Get the download and command", () => void (async () => {
    try {
      const p = await makeCutterPackage(s, station, kind.value as CutterKind);
      const base = (url.value.trim() || location.origin).replace(/\/+$/, "");
      const falcon = p.kind === "creality-falcon";
      out.replaceChildren(
        el("h3", {}, `1. Download (${falcon ? "Creality Falcon" : "practice"} Cutter for ${p.station})`),
        el("p", {}, el("a", { class: "btnlink", href: `${base}${p.downloadPath}`, download: p.fileName }, `Download ${p.fileName}`), el("span", { class: "hint" }, `  Works for an hour (until ${new Date(p.expiresAt).toLocaleTimeString()}). The file holds no token.`)),
        el("h3", {}, "2. On the PC"),
        ...bullets(falcon
          ? ["Unzip it anywhere (the Desktop is fine) and close LightBurn, LaserGRBL and any Creality software: only one program can use the laser's USB port.", "Open a Command Prompt in the unzipped <kerf-cutter> folder."]
          : ["Unzip it, and open a terminal (Command Prompt on Windows) in the unzipped <kerf-cutter> folder.", "Install Python 3.11 or newer if it is not there, then once: <python -m pip install websockets>",
             "Mac with Python from python.org: if the command stops with CERTIFICATE_VERIFY_FAILED, run this once (or double-click it in Finder; use your Python's version number), then run the command again: </Applications/Python\\ 3.12/Install\\ Certificates.command>"]),
        el("h3", {}, "3. Run this command"),
        ...(falcon ? [row("Windows (first time; it is remembered after that, so later you just double-click run_cutter.bat)", cutterCommand(base, p.token, p.station, "creality-falcon"))]
                 : [row("Windows", cutterCommand(base, p.token, p.station, "practice", "windows")), row("Mac or Linux", cutterCommand(base, p.token, p.station, "practice", "unix"))]),
        el("p", { class: "hint" }, `The token is shown only now and lets whoever has it connect as ${p.station}: keep it private. If it gets out, revoke ${p.station} on the Staff page and make a new one. Each time you press the button a new token is made; the old ones keep working until revoked.`),
        el("p", { class: "hint" }, "Then open the Editor on that PC and sign in with the same token. The station shows as online here."));
    } catch (e) { await infoDialog("That didn't work", [msg(e)]); }
  })(), "on");
  dlg.append(el("h2", {}, `Cutter software for ${station}`),
    el("p", { class: "hint" }, "Use the address the PC types to reach this server, e.g. https://kerf.example.org or http://192.168.1.20:8000. \"localhost\" only works if the server runs on that same PC."),
    el("div", { class: "ad-bar" }, el("label", {}, "Cutter ", kind), el("label", {}, "Server address ", url), go), out,
    el("div", { class: "krow" }, btn("Close", () => dlg.close())));
  await show();
}

const stations: Page = {
  key: "stations", title: "Stations", lead: "The school's laser stations: add, change or remove one, see whether its Cutter is connected, and get the Cutter software with the command that starts it on that station's PC.",
  mount(host, ctx) {
    const s = ctx.session;
    const isAdmin = s.role === "admin";
    let redraw: () => void = () => {};
    const draw = async () => {
      const list = await listStations(s);
      const machines = new Map((await listMachines(s)).map((m) => [m.id, m]));
      const add = btn("Add a station", () => void (async () => { if (await stationForm(s)) redraw(); })(), "on");
      const card = (st: StationInfo) => {
        const m = machines.get(st.id);
        const pct = st.progress && st.progress.totalLines > 0 ? Math.round((100 * st.progress.line) / st.progress.totalLines) : null;
        const send = (c: "stop" | "pause" | "resume") => void attempt(() => controlStation(s, st.id, c), () => {});
        return el("div", { class: "ad-card" }, el("h3", {}, st.id, " ", el("span", { class: `ad-tag ${st.online ? "ok" : "warn"}` }, st.online ? (st.state ?? "online") : "offline")),
          el("div", { class: "hint" }, [m?.name, m ? `${m.bed.widthMm} x ${m.bed.heightMm} mm bed` : ""].filter(Boolean).join(" · ")),
          el("div", { class: "hint" }, st.online ? `Cutter ${st.cutterVersion ?? "?"}` : `Last seen ${st.lastSeen ? new Date(st.lastSeen).toLocaleString() : "never"}`),
          ...(st.currentJobId ? [el("p", {}, `Cutting ${st.currentJobId}${pct !== null ? ` · ${pct}%` : ""}`)] : []),
          el("p", {}, el("span", { class: `ad-tag ${st.calibrated ? "ok" : "warn"}` }, st.calibrated ? "camera calibrated" : "camera not calibrated")),
          el("div", { class: "row" },
            ...(st.online && !st.currentJobId ? [btn("Disconnect Cutter", () => { if (confirm(`Disconnect the Cutter from ${st.id}? It stays disconnected until someone starts it again on its PC.`)) void attempt(() => disconnectStation(s, st.id), redraw); })] : []),
            ...(st.online ? [btn("Pause", () => send("pause")), btn("Resume", () => send("resume")), btn("Stop", () => { if (confirm(`Stop ${st.id}?`)) send("stop"); }, "danger")] : [])),
          el("div", { class: "row" },
            btn("Edit", () => void (async () => {
              let cur;
              try { cur = await getMachineDoc(s, st.id); } catch (e) { await infoDialog("That didn't work", [msg(e)]); return; }
              if (await stationForm(s, cur)) redraw();
            })()),
            ...(isAdmin ? [btn("Cutter software", () => void cutterSoftware(s, st.id), "on"),
              btn("Delete", () => { if (confirm(`Delete ${st.id}? Its camera calibration and its Cutter tokens are removed too. This cannot be undone.`)) void attempt(() => deleteMachine(s, st.id), redraw); }, "danger")] : [])),
          ...(st.calibrated ? [] : [el("p", { class: "hint" }, "To calibrate: at that station's PC, on its Station page, press \"Calibrate camera\" and enter a teacher token.")]));
      };
      host.replaceChildren(el("div", { class: "ad-bar" }, add),
        list.length ? el("div", { class: "ad-stations" }, ...list.map(card)) : empty("No stations yet. Press \"Add a station\"."));
    };
    redraw = () => void draw().catch((e) => fail(host, e));
    return refreshing(host, draw, 3000);
  },
};

// ---------------------------------------------------------------- staff (school admins)

const staff: Page = {
  key: "staff", title: "Station tokens", lead: "The tokens the Cutter programs use to connect (one per laser). People sign in with DINO, so there are no other tokens. A token is shown once; only its hash is kept.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const list = (await listStaff(s)).filter((m) => m.role === "station");
      const redraw = () => void draw().catch((e) => fail(host, e));
      const bar = el("div", { class: "ad-bar" }, btn("New station token…", () => void (async () => {
        const v = await openDialog("New station token", [
          { key: "id", label: "Laser ID", type: "text", value: "", hint: "The laser's ID, e.g. station-1. Letters, digits, - and _" },
        ], { ok: "Make token" });
        if (!v || !String(v.id).trim()) return;
        await attempt(async () => {
          const r = await addStaff(s, "station", String(v.id).trim());
          await showToken("Token", `Laser station: ${r.id}`, r.token, "Copy this now. It is not shown again. Give it to the Cutter program on the laser PC.");
        }, redraw);
      })(), "on"));
      host.replaceChildren(bar, ...(list.length ? [table(["Laser", "Added", ""], list.map((m) => el("tr", {}, cell(el("b", {}, m.id)), cell(m.createdAt ? new Date(m.createdAt).toLocaleDateString() : ""),
        actions(btn("Revoke", () => { if (confirm(`Revoke the token for ${m.id}? Its Cutter disconnects and cannot reconnect.`)) void attempt(() => revokeStaff(s, m.id), redraw); }, "danger")))))] : [empty("No station tokens yet.")]));
    };
    void draw().catch((e) => fail(host, e));
  },
};

const ROLE_TEXT: Record<string, string> = { admin: "School admin", teacher: "Teacher", technician: "Technician (laser stations only)" };

/** School admins: invite staff by email. The invite's link lets them choose a password; they then sign in with their school email and password. */
const people: Page = {
  key: "people", title: "Staff", lead: "Invite teachers, technicians and other admins by email. The invite asks them to choose a password; after that they sign in with their school email and password (Forgot your password? on the sign-in page sets a new one). Only admins invite. Staff who sign in with DINO are not listed here.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const list = await listStaffPeople(s);
      const redraw = () => void draw().catch((e) => fail(host, e));
      const invite = (cur?: { email: string; role: string; name: string | null }) => void (async () => {
        const v = await openDialog(cur ? `Invite ${cur.email} again` : "Invite staff", [
          { key: "email", label: "School email address", type: "text", value: cur?.email ?? "" },
          { key: "name", label: "Name (optional)", type: "text", value: cur?.name ?? "", hint: "Shown to your school's staff only" },
          { key: "role", label: "Role", type: "select", value: cur?.role ?? "teacher", options: Object.entries(ROLE_TEXT).map(([value, label]) => ({ value, label })) },
        ], { ok: "Send invite", intro: cur ? "Kerf sends the invite again: a new link to choose their password (it works once, for 7 days)." : "Kerf emails them a link to choose their password (it works once, for 7 days)." });
        if (!v || !String(v.email).trim()) return;
        await attempt(async () => {
          const r = await inviteStaff(s, { email: String(v.email).trim(), role: String(v.role) as "teacher", name: String(v.name ?? "").trim() || undefined });
          await infoDialog("Invite sent", [`An invite is on its way to ${r.email}.`]);
        }, redraw);
      })();
      const bar = el("div", { class: "ad-bar" }, btn("Invite staff…", () => invite(), "on"));
      host.replaceChildren(bar, list.length ? table(["Name", "Email", "Role", "Status", ""], list.map((p) => el("tr", {},
        cell(el("b", {}, p.name ?? "")), cell(p.email), cell(ROLE_TEXT[p.role] ?? p.role),
        cell(p.status === "active" ? `Signed in ${p.lastLogin ? new Date(p.lastLogin).toLocaleDateString() : ""}` : el("span", { class: "ad-tag warn", title: "They have not chosen a password yet" }, "Invited")),
        actions(...(p.status === "invited" ? [btn("Send again", () => invite(p))] : []),
          ...(p.id === s.id ? [] : [btn("Remove", () => { if (confirm(`Remove ${p.name || p.email}? They are signed out at once and cannot sign in again.`)) void attempt(() => removeStaffPerson(s, p.id), redraw); }, "danger")]))))) : empty("Nobody has been invited yet."));
    };
    void draw().catch((e) => fail(host, e));
  },
};

/** Technicians and admins: one link per laser to its Station page (the full-screen queue, Frame and Start at the laser PC). */
export const stationPages: Page = {
  key: "stationpages", title: "Station pages", lead: "Open a laser's Station page: its queue, then Frame and Start. Use it on the PC next to that laser.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const list = await listStations(s);
      host.replaceChildren(...(list.length ? [table(["Laser", "Cutter", ""], list.map((st) => el("tr", {}, cell(el("b", {}, st.id)),
        cell(st.online ? `Connected · ${st.state ?? ""}` : "Not connected"),
        actions(el("a", { class: "btnlink on", href: `/editor/?station=${encodeURIComponent(st.id)}` }, "Open station page")))))] : [empty("There are no stations yet.")]));
    };
    void draw().catch((e) => fail(host, e));
    const t = setInterval(() => void draw().catch(() => {}), 5000);
    return () => clearInterval(t);
  },
};

// ---------------------------------------------------------------- schools (platform owner)

const schools: Page = {
  key: "schools", title: "Schools", lead: "Every school on Kerf, its school code and its plan. Free schools have the free tools; a paid school also has the queue, lasers, Station pages, camera, activities and approval. You see nothing inside a school.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const list = await listSchools(s);
      const redraw = () => void draw().catch((e) => fail(host, e));
      const bar = el("div", { class: "ad-bar" }, btn("New school…", () => void (async () => {
        const v = await openDialog("New school", [
          { key: "id", label: "School ID", type: "text", value: "", hint: "Lower-case letters, digits and -, e.g. westfield-high" },
          { key: "name", label: "Name", type: "text", value: "" },
          { key: "adminEmail", label: "First admin's email (optional)", type: "text", value: "", hint: "Kerf emails them an invite to sign in as the school's admin" },
        ], { ok: "Create" });
        if (!v || !String(v.id).trim() || !String(v.name).trim()) return;
        await attempt(async () => {
          const r = await createSchool(s, String(v.id).trim(), String(v.name).trim(), undefined, undefined, String(v.adminEmail ?? "").trim() || undefined);
          if (r.adminInvite) await infoDialog("School created", [`An invite is on its way to ${r.adminInvite.email}.`]);
        }, redraw);
      })(), "on"));
      host.replaceChildren(bar, list.length ? table(["ID", "Name", "School code", "Plan", "Created", ""], list.map((x) => {
        const plan = el("select", { "aria-label": `Plan for ${x.name}` }, new Option("Free", "free"), new Option("Paid", "paid")) as HTMLSelectElement;
        plan.value = x.plan ?? "paid";
        plan.addEventListener("change", () => {
          const want = plan.value as "free" | "paid";
          if (!confirm(`Put ${x.name} on the ${want} plan?${want === "free" ? " Its queue, lasers, Station pages, camera, activities and approval stop working." : ""}`)) { plan.value = x.plan ?? "paid"; return; }
          void attempt(() => updateSchool(s, x.id, { plan: want }), redraw);
        });
        const terms = btn("Terms…", () => void editSchoolTerms(s, x.id, x.name).then(redraw));
        return el("tr", {}, cell(el("b", {}, x.id)), cell(x.name), cell(el("code", {}, x.code ?? "")), cell(plan), cell(x.createdAt ? new Date(x.createdAt).toLocaleDateString() : ""),
          actions(...(x.plan === "free" ? [terms] : [])));
      })) : empty("No schools yet."));
    };
    void draw().catch((e) => fail(host, e));
  },
};

type Features = { laser: boolean; activities: boolean };
const featuresOf = (f: Features | string | null | undefined): Features =>
  f && typeof f === "object" ? f : f === "free" ? { laser: false, activities: false } : { laser: true, activities: true };

/** The School Admin site's pages for this role and what the school's plan gives it (`features` from /auth/me, or an older
 * server's plan name). Without the laser there is no queue, overview, lasers or Station pages; without activities, no Activities page. */
export function pagesFor(role: string, features: Features | string | null | undefined = "paid"): Page[] {
  if (role === "platform") return platformPages();
  const f = featuresOf(features);
  if (role === "technician") return f.laser ? [stationPages] : []; // technicians run the stations and see nothing else here
  const base = [...(f.laser ? [overview] : []), classes, pupils, ...(f.activities ? [activities] : []), ...(f.laser ? [queue] : []), materials, ...(f.laser ? [stations] : [])];
  return role === "admin" ? [...base, ...(f.laser ? [stationPages] : []), schoolPage, people, ...(f.laser ? [staff] : [])] : base;
}

/** The Platform: one school's own terms (a free school's copy of the default, made when it registered). */
async function editSchoolTerms(s: Session, id: string, name: string): Promise<void> {
  try {
    const cur = await getSchoolTerms(s, id);
    const base: Terms = cur.terms ?? await getDefaultTerms(s);
    const v = await openDialog(`Terms for ${name}`, termsFields(base, false), { ok: "Save" });
    if (!v) return;
    const saved = await setSchoolTerms(s, id, termsFromForm(v, false));
    await infoDialog(`${name} now has`, [termsText(saved.now), ...saved.now.grants.map((g) => `${g.label}${g.until ? ` until ${new Date(g.until).toLocaleDateString()}` : ""}`)]);
  } catch (e) { await infoDialog("That didn't work", [msg(e)]); }
}

/** The Platform: Kerf's default terms, copied to each new free school when it registers. */
const defaultTerms: Page = {
  key: "terms", title: "Default terms", lead: "What a free school gets when it registers. The school keeps a copy: changing these later does not change schools that already exist (use Terms… on the Schools page for one school).",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const t = await getDefaultTerms(s);
      const redraw = () => void draw().catch((e) => fail(host, e));
      host.replaceChildren(el("div", { class: "ad-card" }, el("p", {}, el("b", {}, "Always: "), termsText(t)),
        ...t.grants.map((g) => el("p", {}, el("b", {}, `${g.label}: `), `for ${g.months} month${g.months === 1 ? "" : "s"} from registration, `, termsText({ features: { laser: !!g.features.laser, activities: !!g.features.activities }, limits: g.limits as Record<string, number | null> }).replace(" · no limits", ""))),
        el("div", { class: "ad-bar" }, btn("Change…", () => void (async () => {
          const v = await openDialog("Default terms for new schools", termsFields(t, true), { ok: "Save" });
          if (!v) return;
          await attempt(async () => { await setDefaultTerms(s, termsFromForm(v, true)); }, redraw);
        })(), "on"))));
    };
    void draw().catch((e) => fail(host, e));
  },
};

const SIGN_IN_LABELS: [keyof SignInSettings["methods"], string, string][] = [
  ["groupCode", "Group code", "Pupils type the school code, their group code, their pupil ID and the password on their card."],
  ["email", "Email and password", "Staff sign in with their school email and a password they choose. Email is used to check the address (invites, Forgot your password?)."],
  ["dino", "DINO", "Staff and pupils sign in with their DINO account."],
  ["google", "Google", "Staff and pupils sign in with the school's Google accounts."],
  ["microsoft", "Microsoft", "Staff and pupils sign in with the school's Microsoft 365 accounts."],
];

/** School admins: the school's code and plan, and which sign-in methods are on. */
const schoolPage: Page = {
  key: "school", title: "School", lead: "Your school's code and plan, and how people sign in. At least one way for staff to sign in must stay on.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const [sc, si, now] = await Promise.all([mySchool(s), getSignIn(s), myTerms(s).catch(() => null)]);
      const redraw = () => void draw().catch((e) => fail(host, e));
      const rows = SIGN_IN_LABELS.map(([k, label, hint]) => {
        const box = el("input", { type: "checkbox", "aria-label": label }) as HTMLInputElement;
        box.checked = si.methods[k];
        box.disabled = !si.methods[k] && !si.canEnable[k];
        box.addEventListener("change", () => void attempt(() => setSignIn(s, { methods: { [k]: box.checked } }), redraw));
        const note = !si.available[k] ? "Coming soon: can be set now, starts working when it is released." : !si.methods[k] && !si.canEnable[k] ? (k === "dino" ? "Linked to another school on this server." : "Kerf has not been registered with this provider yet.") : "";
        return el("tr", {}, cell(el("label", {}, box, " ", el("b", {}, label))), cell(hint), cell(note ? el("span", { class: "hint" }, note) : ""));
      });
      const rename = () => void (async () => {
        let value = sc.name, problem = "";
        for (;;) {
          const v = await openDialog("Rename the school", [{ key: "name", label: "School name", type: "text", value }], { ok: "Save", intro: problem || "Up to 128 characters. The school code stays the same." });
          if (!v) return;
          value = String(v.name ?? "");
          const c = checkSchoolName(value);
          if ("error" in c) { problem = c.error; continue; }
          if (c.name === sc.name) return;
          await attempt(async () => { const saved = await renameSchool(s, c.name); ctx.renamed?.(saved.name); }, redraw);
          return;
        }
      })();
      const title = el("h3", {}, sc.name);
      const nameRow = s.role === "admin" ? el("div", { class: "ad-bar" }, title, btn("Rename…", rename)) : title;
      host.replaceChildren(
        el("div", { class: "ad-card" }, nameRow, el("p", {}, "School code: ", el("code", { class: "ad-code" }, sc.code ?? "")),
          el("p", { class: "hint" }, "Pupils type this school code when they sign in with a group code."),
          el("p", {}, `Plan: ${sc.plan === "free" ? "Free" : "Paid (everything, no limits)"}`),
          ...(now && !now.paid ? [el("p", {}, termsText(now)), ...now.grants.map((g) => el("p", { class: "hint" }, `${g.label}${g.until ? `, until ${new Date(g.until).toLocaleDateString()}` : ""}`))] : [])),
        el("h2", {}, "How people sign in"), table(["Method", "", ""], rows));
    };
    void draw().catch((e) => fail(host, e));
  },
};

/** The Platform site (Kerf's site admins only): all schools. */
export const platformPages = (): Page[] => [schools, defaultTerms];
