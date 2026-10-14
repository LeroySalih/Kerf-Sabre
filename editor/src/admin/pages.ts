// The pages of the admin site. Each page draws itself into a host element and may return a function that stops its refreshing.
import { openClasses, showPins } from "../classesui";
import { openClassWork } from "../activitiesui";
import { infoDialog, openDialog } from "../dialog";
import { btn, el, modal, msg, shortDate } from "../dom";
import { mountQueue } from "../stationui";
import { previewSvg } from "../stationlogic";
import {
  addStaff, classActivities, classPupils, controlStation, createClass, createSchool, describeDuration, listClasses, listQueue, listSchools, listStaff, listStations,
  listJobsByStatus, removePupil, resetPin, revokeStaff, updateClass,
  type Activity, type JobSummary, type Session, type StationInfo,
} from "../server";

export interface Ctx { session: Session; school: string; go: (key: string) => void }
export interface Page { key: string; title: string; lead: string; mount: (host: HTMLElement, ctx: Ctx) => void | (() => void) }

const fail = (host: HTMLElement, e: unknown) => host.replaceChildren(el("p", { class: "ad-err" }, msg(e)));
const empty = (text: string) => el("div", { class: "ad-empty" }, text);
const th = (...names: string[]) => el("tr", {}, ...names.map((n) => el("th", {}, n)));
const table = (head: string[], rows: HTMLElement[]) => el("table", { class: "ad-table" }, th(...head), ...rows);
const cell = (...k: (string | Node)[]) => el("td", {}, ...k);
const actions = (...k: Node[]) => el("td", { class: "actions" }, el("div", {}, ...k));
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
  dlg.append(el("h2", {}, `${j.pupilId ?? "Pupil"}: ${j.id}`), view,
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
        card(`${online}/${stations.length}`, "lasers online", "lasers"), card(classes.length, "classes", "classes"),
        card(classes.reduce((n, c) => n + c.pupilCount, 0), "pupils", "pupils"));
      [...cards.children].forEach((c, i) => { const to = ["queue", "queue", "lasers", "classes", "pupils"][i]!; c.addEventListener("click", () => ctx.go(to)); });
      host.replaceChildren(cards, ...(waiting.length ? [el("p", {}, btn(`Review ${plural(waiting.length, "file")}`, () => ctx.go("queue"), "on"))] : []));
    }, 5000);
  },
};

// ---------------------------------------------------------------- classes

const APPROVAL = [{ v: "yes", text: "A teacher approves each file" }, { v: "no", text: "Straight to the queue" }];

const classes: Page = {
  key: "classes", title: "Classes", lead: "Each class has its own sign-in code, pupils and activities. Choose how its files reach the laser.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const list = await listClasses(s);
      const redraw = () => void draw().catch((e) => fail(host, e));
      const bar = el("div", { class: "ad-bar" }, btn("New class…", () => void (async () => {
        const v = await openDialog("New class", [
          { key: "code", label: "Class code", type: "text", value: "", hint: "Letters, digits, - and _. Pupils type this to sign in" },
          { key: "label", label: "Note (optional)", type: "text", value: "", hint: "For you, e.g. Year 9 set 2. Not a pupil name" },
          { key: "approval", label: "Files from this class", type: "select", value: "yes", options: APPROVAL.map((a) => ({ value: a.v, label: a.text })) },
        ], { ok: "Create" });
        if (v && String(v.code).trim()) await attempt(() => createClass(s, String(v.code).trim(), String(v.label).trim(), v.approval !== "no"), redraw);
      })(), "on"));
      if (!list.length) return host.replaceChildren(bar, empty("No classes yet. Create one, then add the pupil IDs."));
      host.replaceChildren(bar, table(["Class", "Note", "Teacher", "Pupils", "Files from this class", ""], list.map((c) => {
        const sel = el("select", { "aria-label": `Approval for ${c.code}` }, ...APPROVAL.map((a) => new Option(a.text, a.v)));
        sel.value = c.requireApproval === false ? "no" : "yes";
        sel.addEventListener("change", () => void attempt(() => updateClass(s, c.code, { requireApproval: sel.value !== "no" }), redraw));
        return el("tr", {}, cell(el("b", {}, c.code)), cell(c.label ?? ""), cell(c.teacherId ?? "shared"), cell(String(c.pupilCount)), cell(sel),
          actions(btn("Pupils and PINs…", () => openClasses(s, { openFile: lookAtFile }, c.code)), btn("Activities…", () => void openClassWork(s, c.code, { openFile: lookAtFile }, "activities")),
            btn("Progress…", () => void openClassWork(s, c.code, { openFile: lookAtFile }, "progress"))));
      })), el("p", { class: "hint" }, "Changing the approval setting only affects files sent from now on. Files already waiting stay as they are."));
    };
    void draw().catch((e) => fail(host, e));
  },
};

// ---------------------------------------------------------------- pupils

const pupils: Page = {
  key: "pupils", title: "Pupils", lead: "Every pupil in the school, by class. Pupil IDs only, never names. A PIN is shown once when it is made.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const cls = await listClasses(s);
      const all = await Promise.all(cls.map(async (c) => ({ c, rows: await classPupils(s, c.code) })));
      const redraw = () => void draw().catch((e) => fail(host, e));
      const rows: HTMLElement[] = [];
      for (const { c, rows: ps } of all) for (const p of ps) {
        rows.push(el("tr", {}, cell(el("b", {}, p.pupilId)), cell(c.code), cell(p.lastLogin ? new Date(p.lastLogin).toLocaleString() : "never"), cell(p.locked ? el("span", { class: "ad-tag warn" }, "locked") : ""),
          actions(btn("New PIN", () => void attempt(async () => { const r = await resetPin(s, p.pupilId); await showPins("New PIN", [r]); }, redraw)),
            btn("Remove", () => { if (confirm(`Remove ${p.pupilId} from ${c.code}? They will be signed out.`)) void attempt(() => removePupil(s, c.code, p.pupilId), redraw); }, "danger"))));
      }
      host.replaceChildren(...(rows.length ? [table(["Pupil ID", "Class", "Last signed in", "", ""], rows)] : [empty(cls.length ? "No pupils yet. Open a class and add pupil IDs." : "No classes yet.")]),
        ...(cls.length ? [el("p", { class: "hint" }, "To add pupils, open the class on the Classes page.")] : []));
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
  mount: (host, ctx) => mountQueue(host, ctx.session),
};

// ---------------------------------------------------------------- lasers

const lasers: Page = {
  key: "lasers", title: "Lasers", lead: "The school's laser cutters and whether they are connected.",
  mount(host, ctx) {
    const s = ctx.session;
    return refreshing(host, async () => {
      const list = await listStations(s);
      if (!list.length) return host.replaceChildren(empty("No lasers are registered for this school yet."));
      const card = (st: StationInfo) => {
        const pct = st.progress && st.progress.totalLines > 0 ? Math.round((100 * st.progress.line) / st.progress.totalLines) : null;
        const send = (c: "stop" | "pause" | "resume") => void attempt(() => controlStation(s, st.id, c), () => {});
        return el("div", { class: "ad-card" }, el("h3", {}, st.id, " ", el("span", { class: `ad-tag ${st.online ? "ok" : "warn"}` }, st.online ? (st.state ?? "online") : "offline")),
          el("div", { class: "hint" }, st.online ? `Cutter ${st.cutterVersion ?? "?"}` : `Last seen ${st.lastSeen ? new Date(st.lastSeen).toLocaleString() : "never"}`),
          ...(st.currentJobId ? [el("p", {}, `Cutting ${st.currentJobId}${pct !== null ? ` · ${pct}%` : ""}`)] : []),
          ...(st.online ? [el("div", { class: "row" }, btn("Pause", () => send("pause")), btn("Resume", () => send("resume")), btn("Stop", () => { if (confirm(`Stop ${st.id}?`)) send("stop"); }, "danger"))] : []));
      };
      host.replaceChildren(el("div", { class: "ad-stations" }, ...list.map(card)));
    }, 3000);
  },
};

// ---------------------------------------------------------------- staff (school admins)

const ROLE_TEXT: Record<string, string> = { admin: "School admin", teacher: "Teacher", station: "Laser station" };
const staff: Page = {
  key: "staff", title: "Staff", lead: "Teachers, other admins and laser-station tokens for this school. A token is shown once; only its hash is kept.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const list = await listStaff(s);
      const redraw = () => void draw().catch((e) => fail(host, e));
      const bar = el("div", { class: "ad-bar" }, btn("Add someone…", () => void (async () => {
        const v = await openDialog("Add staff", [
          { key: "role", label: "Role", type: "select", value: "teacher", options: [{ value: "teacher", label: "Teacher (their own classes)" }, { value: "admin", label: "School admin (everything in the school)" }, { value: "station", label: "Laser station (a laser PC)" }] },
          { key: "id", label: "ID", type: "text", value: "", hint: "Letters, digits, - and _. An ID, never a name. For a station this is the laser's ID" },
        ], { ok: "Add" });
        if (!v || !String(v.id).trim()) return;
        await attempt(async () => {
          const r = await addStaff(s, v.role as "admin" | "teacher" | "station", String(v.id).trim());
          await showToken("Token", `${ROLE_TEXT[r.role] ?? r.role}: ${r.id}`, r.token, "Copy this now. It is not shown again. Use it to sign in (teachers and admins: on this site; laser stations: in the Editor on the laser PC).");
        }, redraw);
      })(), "on"));
      host.replaceChildren(bar, table(["ID", "Role", "Added", ""], list.map((m) => el("tr", {}, cell(el("b", {}, m.id)), cell(ROLE_TEXT[m.role] ?? m.role), cell(m.createdAt ? new Date(m.createdAt).toLocaleDateString() : ""),
        actions(...(m.id === s.id ? [] : [btn("Revoke", () => { if (confirm(`Revoke ${m.id}? Their token stops working straight away.`)) void attempt(() => revokeStaff(s, m.id), redraw); }, "danger")]))))));
    };
    void draw().catch((e) => fail(host, e));
  },
};

// ---------------------------------------------------------------- schools (platform owner)

const schools: Page = {
  key: "schools", title: "Schools", lead: "Each school's classes, pupils, files, lasers and materials are private to it. You create schools and their first admin; you see nothing inside them.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const list = await listSchools(s);
      const redraw = () => void draw().catch((e) => fail(host, e));
      const bar = el("div", { class: "ad-bar" }, btn("New school…", () => void (async () => {
        const v = await openDialog("New school", [
          { key: "id", label: "School ID", type: "text", value: "", hint: "Lower-case letters, digits and -, e.g. bisak" },
          { key: "name", label: "Name", type: "text", value: "" },
          { key: "admin", label: "First admin's ID", type: "text", value: "", hint: "They get a token to sign in and set up their own teachers" },
        ], { ok: "Create" });
        if (!v || !String(v.id).trim() || !String(v.name).trim()) return;
        await attempt(async () => {
          const r = await createSchool(s, String(v.id).trim(), String(v.name).trim(), String(v.admin).trim() || undefined);
          if (r.admin) await showToken("School created", `${r.name}: first admin ${r.admin.id}`, r.admin.token, "Give this token to the school's admin. It is not shown again.");
        }, redraw);
      })(), "on"));
      host.replaceChildren(bar, list.length ? table(["ID", "Name", "Created"], list.map((x) => el("tr", {}, cell(el("b", {}, x.id)), cell(x.name), cell(x.createdAt ? new Date(x.createdAt).toLocaleDateString() : "")))) : empty("No schools yet."));
    };
    void draw().catch((e) => fail(host, e));
  },
};

export function pagesFor(role: string): Page[] {
  if (role === "platform") return [schools];
  const base = [overview, classes, pupils, activities, queue, lasers];
  return role === "admin" ? [...base, staff] : base;
}
