// The pages of the admin site. Each page draws itself into a host element and may return a function that stops its refreshing.
import { openClasses } from "../classesui";
import { openClassWork } from "../activitiesui";
import { infoDialog, openDialog, type DialogValue } from "../dialog";
import { profileFromForm, stationFields } from "../machineform";
import { btn, el, modal, msg, shortDate } from "../dom";
import { mountQueue } from "../stationui";
import { previewSvg } from "../stationlogic";
import {
  addStaff, classActivities, classPupils, controlStation, cutterCommand, cutterKinds, deleteMachine, getMachineDoc, listMachines, makeCutterPackage, putMachine, createClass, createSchool, describeDuration, listClasses, listQueue, listSchools, listStaff, listStations,
  listJobsByStatus, removePupil, revokeStaff, updateClass,
  type Activity, type CutterKind, type JobSummary, type Session, type StationInfo,
} from "../server";

export interface Ctx { session: Session; school: string; go: (key: string) => void }
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
      if (!list.length) return host.replaceChildren(bar, empty("No classes yet. Create one, then add the pupils' DINO IDs."));
      host.replaceChildren(bar, table(["Class", "Note", "Teacher", "Pupils", "Files from this class", ""], list.map((c) => {
        const sel = el("select", { "aria-label": `Approval for ${c.code}` }, ...APPROVAL.map((a) => new Option(a.text, a.v)));
        sel.value = c.requireApproval === false ? "no" : "yes";
        sel.addEventListener("change", () => void attempt(() => updateClass(s, c.code, { requireApproval: sel.value !== "no" }), redraw));
        return el("tr", {}, cell(el("b", {}, c.code)), cell(c.label ?? ""), cell(c.teacherId ?? "shared"), cell(String(c.pupilCount)), cell(sel),
          actions(btn("Pupils…", () => openClasses(s, { openFile: lookAtFile }, c.code)), btn("Activities…", () => void openClassWork(s, c.code, { openFile: lookAtFile }, "activities")),
            btn("Progress…", () => void openClassWork(s, c.code, { openFile: lookAtFile }, "progress"))));
      })), el("p", { class: "hint" }, "Changing the approval setting only affects files sent from now on. Files already waiting stay as they are."));
    };
    void draw().catch((e) => fail(host, e));
  },
};

// ---------------------------------------------------------------- pupils

const pupils: Page = {
  key: "pupils", title: "Pupils", lead: "Every pupil in the school, by class. Pupil IDs (their DINO IDs) only, never names.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const cls = await listClasses(s);
      const all = await Promise.all(cls.map(async (c) => ({ c, rows: await classPupils(s, c.code) })));
      const redraw = () => void draw().catch((e) => fail(host, e));
      const rows: HTMLElement[] = [];
      for (const { c, rows: ps } of all) for (const p of ps) {
        rows.push(el("tr", {}, cell(el("b", {}, p.pupilId)), cell(c.code), cell(p.lastLogin ? new Date(p.lastLogin).toLocaleString() : "never"),
          actions(btn("Remove", () => { if (confirm(`Remove ${p.pupilId} from ${c.code}? They will be signed out.`)) void attempt(() => removePupil(s, c.code, p.pupilId), redraw); }, "danger"))));
      }
      host.replaceChildren(...(rows.length ? [table(["Pupil ID", "Class", "Last signed in", ""], rows)] : [empty(cls.length ? "No pupils yet. Open a class and add pupils' DINO IDs." : "No classes yet.")]),
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
    new Option(kinds.real.available ? "Real Cutter: runs a laser from a Windows PC" : "Real Cutter (not built on this server yet)", "real")) as HTMLSelectElement;
  (kind.options[1] as HTMLOptionElement).disabled = !kinds.real.available;
  const url = el("input", { type: "text", value: s.baseUrl || location.origin, "aria-label": "Server address", style: "min-width:22em" }) as HTMLInputElement;
  const out = el("div");
  const row = (label: string, cmd: string) => el("div", { class: "ad-cmd" }, el("div", { class: "hint" }, label), el("div", { class: "ad-token" }, cmd), btn("Copy", () => void navigator.clipboard?.writeText(cmd)));
  const go = btn("Get the download and command", () => void (async () => {
    try {
      const p = await makeCutterPackage(s, station, kind.value as CutterKind);
      const base = (url.value.trim() || location.origin).replace(/\/+$/, "");
      const real = p.kind === "real";
      out.replaceChildren(
        el("h3", {}, `1. Download (${real ? "real" : "practice"} Cutter for ${p.station})`),
        el("p", {}, el("a", { class: "btnlink", href: `${base}${p.downloadPath}`, download: p.fileName }, `Download ${p.fileName}`), el("span", { class: "hint" }, `  Works for an hour (until ${new Date(p.expiresAt).toLocaleTimeString()}). The file holds no token.`)),
        el("h3", {}, "2. On the PC"),
        ...bullets(real
          ? ["Unzip it anywhere (the Desktop is fine) and close LightBurn, LaserGRBL and any Creality software: only one program can use the laser's USB port.", "Open a Command Prompt in the unzipped <kerf-cutter> folder."]
          : ["Unzip it, and open a terminal (Command Prompt on Windows) in the unzipped <kerf-cutter> folder.", "Install Python 3.11 or newer if it is not there, then once: <python -m pip install websockets>",
             "Mac with Python from python.org: if the command stops with CERTIFICATE_VERIFY_FAILED, run this once (or double-click it in Finder; use your Python's version number), then run the command again: </Applications/Python\\ 3.12/Install\\ Certificates.command>"]),
        el("h3", {}, "3. Run this command"),
        ...(real ? [row("Windows (first time; it is remembered after that, so later you just double-click run_cutter.bat)", cutterCommand(base, p.token, p.station, "real"))]
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

/** Technicians and admins: one link per laser to its Station page (the full-screen queue, Frame and Start at the laser PC). */
export const stationPages: Page = {
  key: "stationpages", title: "Station pages", lead: "Open a laser's Station page: its queue, then Frame and Start. Use it on the PC next to that laser.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const list = await listStations(s);
      host.replaceChildren(...(list.length ? [table(["Laser", "Cutter", ""], list.map((st) => el("tr", {}, cell(el("b", {}, st.id)),
        cell(st.online ? `Connected · ${st.state ?? ""}` : "Not connected"),
        actions(el("a", { class: "btnlink on", href: `/?station=${encodeURIComponent(st.id)}` }, "Open station page")))))] : [empty("There are no stations yet.")]));
    };
    void draw().catch((e) => fail(host, e));
    const t = setInterval(() => void draw().catch(() => {}), 5000);
    return () => clearInterval(t);
  },
};

// ---------------------------------------------------------------- schools (platform owner)

const schools: Page = {
  key: "schools", title: "Schools", lead: "Each school's classes, pupils, files, lasers and materials are private to it. You create schools; people in them sign in with DINO, and you see nothing inside them.",
  mount(host, ctx) {
    const s = ctx.session;
    const draw = async () => {
      const list = await listSchools(s);
      const redraw = () => void draw().catch((e) => fail(host, e));
      const bar = el("div", { class: "ad-bar" }, btn("New school…", () => void (async () => {
        const v = await openDialog("New school", [
          { key: "id", label: "School ID", type: "text", value: "", hint: "Lower-case letters, digits and -, e.g. bisak" },
          { key: "name", label: "Name", type: "text", value: "" },
          
        ], { ok: "Create" });
        if (!v || !String(v.id).trim() || !String(v.name).trim()) return;
        await attempt(async () => {
          await createSchool(s, String(v.id).trim(), String(v.name).trim());
        }, redraw);
      })(), "on"));
      host.replaceChildren(bar, list.length ? table(["ID", "Name", "Created"], list.map((x) => el("tr", {}, cell(el("b", {}, x.id)), cell(x.name), cell(x.createdAt ? new Date(x.createdAt).toLocaleDateString() : "")))) : empty("No schools yet."));
    };
    void draw().catch((e) => fail(host, e));
  },
};

export function pagesFor(role: string): Page[] {
  if (role === "platform") return [schools];
  if (role === "technician") return [stationPages]; // technicians run the stations and see nothing else here
  const base = [overview, classes, pupils, activities, queue, stations];
  return role === "admin" ? [...base, stationPages, staff] : base;
}
