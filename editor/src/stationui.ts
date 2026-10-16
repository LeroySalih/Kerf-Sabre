// Station mode (laser PC, signed in with the station token) and the teacher's Queue screen.
// Station mode: the queue, the job that is next for this laser, Frame, confirm the material, Start, progress, Stop.
// Nothing here talks to the laser: the server relays to the Cutter on this PC.
import { createAlignView, type AlignView } from "./alignui";
import { openCalibration } from "./calibrateui";
import type { Calibration } from "./alignlogic";
import { infoDialog, openDialog } from "./dialog";
import { findPreset, presetLabel } from "./presets";
import {
  STATUS_TEXT, ServerError, approveJob, assignJob, cameraUrl, cancelJob, controlStation, deferJob, describeDuration, frameJob, getCalibration, getJob, getMachine, placeJob,
  listJobsByStatus, listQueue, listStations, moveInQueue, rejectJob,
  type JobSummary, type QueueEntry, type Session, type StationInfo,
} from "./server";
import { formatClock, previewSvg, progressPct, sizeOf, sizeText, stepState } from "./stationlogic";

const POLL_MS = 2000;

type Kid = string | Node;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") el.className = v; else el.setAttribute(k, v); }
  el.append(...kids);
  return el;
}
const button = (label: string, onClick: () => void, cls = ""): HTMLButtonElement => {
  const b = h("button", { type: "button", class: cls }, label);
  b.addEventListener("click", () => onClick());
  return b;
};
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A poller that never overlaps itself and stops cleanly. */
function poller(fn: () => Promise<void>, ms = POLL_MS): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    try { await fn(); } catch { /* shown by the screen as "connection lost" next time */ }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}

// ---------------------------------------------------------------- Station mode

/** A technician (or an admin) opens a laser's Station page: `stationId` says which laser; `onOtherStation` offers the picker again. */
export function openStation(session: Session, onSignOut: () => void, opts: { stationId?: string; onOtherStation?: () => void } = {}): void {
  const root = document.getElementById("station")!;
  root.hidden = false;
  root.replaceChildren();
  const stationId = opts.stationId ?? session.id;
  const jobCache = new Map<string, Awaited<ReturnType<typeof getJob>>>();
  let confirmed = false;
  let confirmedFor = "";
  let notice = "";
  let noticeKind: "info" | "error" = "info";
  let lastJob: { id: string; text: string; ok: boolean } | null = null;
  let seenCurrent: string | null = null;
  let busy = false;
  let cam: string | null = null;
  let calib: Calibration | null | undefined; // undefined: not asked yet; null: this laser's camera is not calibrated
  let bed: { widthMm: number; heightMm: number } | null = null;
  let polls = 0;
  let aligning: { jobId: string; view: AlignView } | null = null;
  let data: { queue: QueueEntry[]; station?: StationInfo; failed: boolean } = { queue: [], failed: false };

  const say = (t: string, kind: "info" | "error" = "info") => { notice = t; noticeKind = kind; render(); };
  const guard = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    busy = true; render();
    try { await fn(); notice = ""; } catch (e) { notice = msg(e); noticeKind = "error"; if (e instanceof ServerError && e.status === 401) onSignOut(); }
    busy = false;
    await refresh();
  };

  async function refresh(): Promise<void> {
    try {
      const [q, stations] = await Promise.all([listQueue(session, stationId), listStations(session)]);
      data = { queue: q, station: stations.find((x) => x.id === stationId), failed: false };
    } catch (e) {
      if (e instanceof ServerError && e.status === 401) { onSignOut(); return; }
      data = { ...data, failed: true };
    }
    const st = data.station;
    if (seenCurrent && !st?.currentJobId) { // a cut just ended: say how it went
      try {
        const j = await getJob(session, seenCurrent);
        lastJob = { id: seenCurrent, ok: j.status === "done", text: j.status === "done" ? "Finished. Take your material out." : `${STATUS_TEXT[j.status] ?? j.status}${j.statusReason ? `: ${j.statusReason}` : ""}` };
      } catch { /* leave it */ }
    }
    seenCurrent = st?.currentJobId ?? null;
    if (st?.cameraAvailable && !aligning) { // a teacher may calibrate while this page is open
      if (!st.calibrated) calib = null;
      else if (!calib || polls++ % 15 === 0) {
        try { calib = await getCalibration(session, stationId); if (calib && !bed) bed = (await getMachine(session, stationId)).bed; } catch { /* try again later */ }
      }
    }
    if (st?.cameraAvailable) { const u = await cameraUrl(session, stationId); if (u) { if (cam) URL.revokeObjectURL(cam); cam = u; } }
    const next = data.queue.find((e) => e.next && e.status === "approved");
    if (next?.jobId && !jobCache.has(next.jobId)) { try { jobCache.set(next.jobId, await getJob(session, next.jobId)); } catch { /* retry next poll */ } }
    render();
  }

  function render(): void {
    const st = data.station;
    const next = data.queue.find((e) => e.next && e.status === "approved");
    const running = st?.currentJobId ? data.queue.find((e) => e.jobId === st.currentJobId) : undefined;
    if (next?.jobId !== confirmedFor) { confirmed = false; confirmedFor = next?.jobId ?? ""; }
    if (aligning && (aligning.jobId !== next?.jobId || st?.currentJobId)) stopAlign(); // the job went away (or a cut started): leave the alignment
    if (aligning && root.contains(aligning.view.el)) return; // the picture and the outline are being worked on: do not rebuild them under the pupil's hand

    const head = h("header", { class: "st-head" },
      h("strong", {}, "BISAK Kerf"), h("span", {}, `Laser: ${stationId}`),
      h("span", { class: `st-dot ${st?.online ? "on" : "off"}` }, st?.online ? `Connected · ${st.state ?? "…"}` : "Cutter not connected"),
      h("span", { class: "spacer" }),
      ...(st?.cameraAvailable ? [button(st.calibrated ? "Recalibrate camera" : "Calibrate camera", () => void calibrate(), st.calibrated ? "" : "on")] : []),
      ...(opts.onOtherStation ? [button("Other stations", () => opts.onOtherStation!())] : []),
      ...(session.role === "admin" || session.role === "technician" ? [h("a", { class: "btnlink", href: "/admin/" }, "Admin site")] : []),
      button("Sign out", onSignOut));
    const main = h("div", { class: "st-main" });
    main.append(h("section", { class: "st-card st-queue" }, h("h2", {}, "Queue"), queueList(data.queue, stationId)));
    const panel = h("section", { class: "st-card st-job" });
    if (data.failed) panel.append(h("p", { class: "st-error", role: "alert" }, "Lost contact with the server. Trying again…"));
    if (st?.currentJobId) panel.append(...cuttingPanel(st, running));
    else panel.append(...readyPanel(next, st));
    if (notice) panel.append(h("p", { class: noticeKind === "error" ? "st-error" : "st-note", role: "alert" }, notice));
    main.append(panel);
    root.replaceChildren(head, main);
  }

  /** Calibrating changes what every pupil sees, so only a technician, teacher or admin (signed in with DINO) may do it. */
  async function calibrate(): Promise<void> {
    if (aligning) return;
    if (!["technician", "teacher", "admin"].includes(session.role)) { say("Only a technician, teacher or admin can calibrate the camera.", "error"); return; }
    const ok = await openDialog("Calibrate the camera", [], { intro: "You will cut test squares in a scrap of material and click their corners in the camera picture. Have a scrap piece ready.", ok: "Continue" });
    if (!ok) return;
    try {
      if (await openCalibration(session, session, stationId)) { calib = undefined; polls = 0; say("The camera calibration was updated."); await refresh(); }
    } catch (e) { say(msg(e), "error"); }
  }

  function stopAlign(): void {
    aligning?.view.destroy();
    aligning = null;
  }

  async function startAlign(jobId: string): Promise<void> {
    const job = jobCache.get(jobId);
    if (!job) return;
    try {
      calib = await getCalibration(session, stationId);
      if (calib && !bed) bed = (await getMachine(session, stationId)).bed;
    } catch (e) { say(msg(e), "error"); return; }
    if (!calib || !bed) { say("This laser's camera has not been set up yet. Ask a teacher to calibrate it on the Admin site.", "error"); return; }
    notice = "";
    const view = createAlignView({
      session, stationId, objects: job.objects, calibration: calib, bed,
      onCancel: () => { stopAlign(); render(); },
      onConfirm: async (matrix) => {
        await placeJob(session, jobId, stationId, matrix);
        jobCache.delete(jobId); // it moved: look at the saved version
        stopAlign();
        notice = "Position saved. Press Frame: the laser traces the outline (laser off) so you can check it sits on your material."; noticeKind = "info";
        await refresh();
      },
    });
    aligning = { jobId, view };
    render();
  }

  function cuttingPanel(st: StationInfo, e: QueueEntry | undefined): Node[] {
    const p = st.progress;
    const pct = progressPct(p);
    const est = p?.estimatedS ?? e?.estimatedS ?? 0;
    const bar = h("div", { class: "st-bar" }, h("div", { class: "st-fill", style: `width:${pct}%` }));
    const paused = st.state === "Hold";
    const out: Node[] = [
      h("h2", {}, e ? `Cutting: ticket ${e.ticket}${e.pupilId ? ` · ${e.pupilId}` : ""}` : "Cutting"),
      bar,
      h("p", {}, `${pct}%${p?.actualS !== undefined ? ` · ${formatClock(p.actualS)} of about ${formatClock(est)}` : ""}${paused ? " · PAUSED" : ""}`),
      h("div", { class: "st-actions" },
        button(paused ? "Resume" : "Pause", () => void guard(() => controlStation(session, stationId, paused ? "resume" : "pause"))),
        button("Stop", () => { if (confirm("Stop cutting now? The job cannot be restarted from where it stopped.")) void guard(() => controlStation(session, stationId, "stop")); }, "danger")),
    ];
    if (cam) out.push(h("img", { class: "st-cam", src: cam, alt: "Camera view of the laser bed" }));
    return out;
  }

  function readyPanel(next: QueueEntry | undefined, st: StationInfo | undefined): Node[] {
    const out: Node[] = [];
    if (lastJob) out.push(h("p", { class: lastJob.ok ? "st-ok" : "st-error", role: "status" }, `${lastJob.id}: ${lastJob.text}`, button("OK", () => { lastJob = null; render(); })));
    const step = stepState(next, st, stationId, confirmed);
    if (!next?.jobId) { out.push(h("h2", {}, "Nothing waiting"), h("p", {}, step.say)); return out; }
    const job = jobCache.get(next.jobId);
    const preset = findPreset(next.presetId ?? job?.preset.id);
    const material = preset ? `${presetLabel(preset)}` : next.presetId ?? "the chosen material";
    const size = job ? sizeOf(job.objects) : null;
    out.push(h("h2", {}, `Next: ticket ${next.ticket}${next.pupilId ? ` · ${next.pupilId}` : ""}`));
    const info = h("div", { class: "st-info" });
    if (job) { const pv = h("div", { class: "st-preview" }); pv.innerHTML = previewSvg(job.objects); info.append(pv); }
    const facts = h("ul", { class: "st-facts" },
      h("li", {}, `Material: ${material}`),
      ...(size ? [h("li", {}, `Size: ${Math.round(size.w * 10) / 10} × ${Math.round(size.h * 10) / 10} mm`)] : []),
      ...(next.estimatedS ? [h("li", {}, `About ${describeDuration(next.estimatedS)} to cut`)] : []),
      ...(job?.origin.mode === "current-position" ? [h("li", {}, `Placed at the laser head (${job.origin.anchor.replace("-", " ")}). Move the head to that spot on your material before you Frame.`)] : []),
      ...(job?.warnings ?? []).map((w) => h("li", { class: "st-warn" }, w)));
    info.append(facts);
    if (aligning?.jobId === next.jobId) { out.push(aligning.view.el); return out; }
    out.push(info);
    if (st?.cameraAvailable && calib && bed && job) out.push(h("div", { class: "st-actions" }, button("Line up on the camera picture", () => void startAlign(next.jobId!), busy ? "disabled" : "on")));
    else if (st?.cameraAvailable && calib === null) out.push(h("p", { class: "hint" }, "Camera alignment is not set up for this laser yet. A teacher can do it on the Admin site (Lasers). Until then, move the laser head to your material and press Frame."));
    out.push(h("p", { class: "st-say" }, step.say));
    const check = h("input", { type: "checkbox" }) as HTMLInputElement;
    check.checked = confirmed;
    check.disabled = !step.framed || busy;
    check.addEventListener("change", () => { confirmed = check.checked; render(); });
    out.push(h("label", { class: "st-confirm" }, check, ` I have loaded ${material}`));
    out.push(h("div", { class: "st-actions" },
      button(step.framed ? "Frame again" : "Frame", () => void guard(async () => { await frameJob(session, next.jobId!, stationId); say("The laser is tracing the outline (laser off). Check it sits on your material."); }), step.canFrame && !busy ? "" : "disabled"),
      button("Start cutting", () => void guard(async () => { await assignJob(session, next.jobId!, stationId, true); confirmed = false; lastJob = null; }), step.canStart && !busy ? "go" : "disabled"),
      button("Not ready: let the next person go", () => void guard(async () => { await deferJob(session, next.jobId!); }), "link")));
    // buttons that look disabled must not act
    out.forEach((n) => (n as HTMLElement).querySelectorAll?.("button.disabled").forEach((b) => ((b as HTMLButtonElement).disabled = true)));
    return out;
  }

  const stop = poller(refresh);
  (root as HTMLElement & { _stop?: () => void })._stop = () => { stop(); stopAlign(); if (cam) URL.revokeObjectURL(cam); };
  render();
}

/** A technician chooses which laser's Station page to open. */
export function openStationPicker(session: Session, onPick: (stationId: string) => void, onSignOut: () => void): void {
  const root = document.getElementById("station")!;
  root.hidden = false;
  const list = h("div", { class: "st-card" }, h("p", { class: "hint" }, "Loading the stations…"));
  const draw = async () => {
    try {
      const all = await listStations(session);
      list.replaceChildren(h("h2", {}, "Choose a laser"), ...(all.length ? all.map((st) => h("p", {}, button(st.id, () => onPick(st.id), "on"), ` ${st.online ? `Connected · ${st.state ?? ""}` : "Cutter not connected"}`)) : [h("p", { class: "hint" }, "There are no stations yet. An admin can add one on the Admin site.")]));
    } catch (e) { list.replaceChildren(h("p", { class: "st-error", role: "alert" }, msg(e))); }
  };
  void draw();
  root.replaceChildren(h("header", { class: "st-head" }, h("strong", {}, "BISAK Kerf"), h("span", {}, "Station pages"), h("span", { class: "spacer" }),
    ...(session.role === "admin" || session.role === "technician" ? [h("a", { class: "btnlink", href: "/admin/" }, "Admin site")] : []), button("Sign out", onSignOut)), h("div", { class: "st-main" }, list));
}

export function closeStation(): void {
  const root = document.getElementById("station") as (HTMLElement & { _stop?: () => void }) | null;
  if (!root) return;
  root._stop?.();
  root.hidden = true;
  root.replaceChildren();
}

function queueList(queue: QueueEntry[], stationId: string): Node {
  if (!queue.length) return h("p", { class: "hint" }, "The queue is empty.");
  const ul = h("ul", { class: "st-qlist" });
  for (const e of queue) {
    const label = e.status === "approved" ? (e.position === 1 ? "Next" : `${e.position}`) : e.status === "running" ? "Cutting" : "Starting";
    const where = e.station && e.station !== stationId ? ` (for ${e.station})` : e.framedOn && e.framedOn !== stationId ? ` (being set up on ${e.framedOn})` : "";
    ul.append(h("li", { class: e.next ? "next" : e.status !== "approved" ? "active" : "" },
      h("b", {}, `#${e.ticket}`), ` ${e.pupilId ?? ""} `, h("span", { class: "tag" }, label), where, e.extentMm ? ` · ${sizeText(e.extentMm)}` : "", e.estimatedS ? ` · ${describeDuration(e.estimatedS)}` : ""));
  }
  return ul;
}

// ---------------------------------------------------------------- Teacher: approvals and queue

/** " · 120 x 85 mm": the design's size (not the bed), from the server, or worked out from the file's shapes for older files. */
function waitingSize(j: JobSummary): string {
  const ext = j.estimate?.extentMm ?? (() => { const s = sizeOf(j.objects); return s ? { widthMm: s.w, heightMm: s.h } : null; })();
  const t = sizeText(ext);
  return t ? ` · ${t}` : "";
}

/** The teacher's approvals and queue as a panel on a page (the admin site). Refreshes itself; returns a function that stops it. */
export function mountQueue(container: HTMLElement, session: Session): () => void {
  let waiting: JobSummary[] = [];
  let queue: QueueEntry[] = [];
  let stations: StationInfo[] = [];
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { await infoDialog("That didn't work", [msg(e)]); } await load(); };
  let busy = false;

  async function load(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      [waiting, queue, stations] = await Promise.all([listJobsByStatus(session, "submitted"), listQueue(session), listStations(session)]);
      draw();
    } finally { busy = false; }
  }

  function draw(): void {
    const approvals = h("div", {}, h("h3", {}, `Waiting for approval (${waiting.length})`));
    if (!waiting.length) approvals.append(h("p", { class: "hint" }, "Nothing to approve. (Classes set to skip approval send files straight to the queue.)"));
    for (const j of waiting) {
      const sel = h("select", { title: "Pupils do not choose a laser: pick the one that should cut this file, or leave it on Any laser for the next free one" }, new Option("Any laser", ""), ...stations.map((s) => new Option(s.id, s.id)));
      approvals.append(h("div", { class: "filerow" },
        h("span", {}, `${j.id} · ${j.pupilId ?? ""} · ${j.preset.id}${waitingSize(j)}${j.estimate?.durationS ? ` · ${describeDuration(j.estimate.durationS)}` : ""}${j.warnings?.length ? ` · ⚠ ${j.warnings.join(" ")}` : ""}`),
        button("Approve", () => void act(() => approveJob(session, j.id, sel.value || undefined)), "go"), sel,
        button("Reject…", () => void (async () => {
          const v = await openDialog("Reject this file", [{ key: "reason", label: "Reason (the pupil sees this)", type: "text", value: "" }], { ok: "Reject" });
          if (v && String(v.reason).trim()) await act(() => rejectJob(session, j.id, String(v.reason).trim()));
        })())));
    }
    const q = h("div", {}, h("h3", {}, `Queue (${queue.length})`));
    if (!queue.length) q.append(h("p", { class: "hint" }, "The queue is empty."));
    for (const e of queue) {
      const row = h("div", { class: "filerow" }, h("span", {}, `#${e.ticket} · ${e.pupilId ?? ""} · ${e.presetId ?? ""}${e.extentMm ? ` · ${sizeText(e.extentMm)}` : ""} · ${e.status === "approved" ? `place ${e.position}` : STATUS_TEXT[e.status] ?? e.status}${e.station ? ` · ${e.station}` : ""}`));
      if (e.status === "approved" && e.jobId) {
        const id = e.jobId;
        row.append(
          button("⤒", () => void act(() => moveInQueue(session, id, { to: "front" })), "icon"), button("↑", () => void act(() => moveInQueue(session, id, { to: "up" })), "icon"),
          button("↓", () => void act(() => moveInQueue(session, id, { to: "down" })), "icon"), button("⤓", () => void act(() => moveInQueue(session, id, { to: "back" })), "icon"),
          button("Cancel", () => { if (confirm(`Cancel ticket ${e.ticket}?`)) void act(() => cancelJob(session, id)); }, "danger"));
      }
      q.append(row);
    }
    container.replaceChildren(approvals, q);
  }

  return poller(load, 3000);
}
