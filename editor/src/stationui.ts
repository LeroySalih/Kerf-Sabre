// Station mode (laser PC, signed in with the station token) and the teacher's Queue screen.
// Station mode: the queue, the job that is next for this laser, Frame, confirm the material, Start, progress, Stop.
// Nothing here talks to the laser: the server relays to the Cutter on this PC.
import { infoDialog, openDialog } from "./dialog";
import { findPreset, presetLabel } from "./presets";
import {
  STATUS_TEXT, ServerError, approveJob, assignJob, cameraUrl, cancelJob, controlStation, deferJob, describeDuration, frameJob, getJob,
  listJobsByStatus, listQueue, listStations, moveInQueue, rejectJob,
  type JobSummary, type QueueEntry, type Session, type StationInfo,
} from "./server";
import { formatClock, previewSvg, progressPct, sizeOf, stepState } from "./stationlogic";

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

export function openStation(session: Session, onSignOut: () => void): void {
  const root = document.getElementById("station")!;
  root.hidden = false;
  root.replaceChildren();
  const stationId = session.id;
  const jobCache = new Map<string, Awaited<ReturnType<typeof getJob>>>();
  let confirmed = false;
  let confirmedFor = "";
  let notice = "";
  let noticeKind: "info" | "error" = "info";
  let lastJob: { id: string; text: string; ok: boolean } | null = null;
  let seenCurrent: string | null = null;
  let busy = false;
  let cam: string | null = null;
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

    const head = h("header", { class: "st-head" },
      h("strong", {}, "BISAK Kerf"), h("span", {}, `Laser: ${stationId}`),
      h("span", { class: `st-dot ${st?.online ? "on" : "off"}` }, st?.online ? `Connected · ${st.state ?? "…"}` : "Cutter not connected"),
      h("span", { class: "spacer" }), button("Sign out", onSignOut));
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
    out.push(info, h("p", { class: "st-say" }, step.say));
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
  (root as HTMLElement & { _stop?: () => void })._stop = () => { stop(); if (cam) URL.revokeObjectURL(cam); };
  render();
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
      h("b", {}, `#${e.ticket}`), ` ${e.pupilId ?? ""} `, h("span", { class: "tag" }, label), where, e.estimatedS ? ` · ${describeDuration(e.estimatedS)}` : ""));
  }
  return ul;
}

// ---------------------------------------------------------------- Teacher: approvals and queue

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
      const sel = h("select", { title: "Optionally cut on one laser only" }, new Option("Any laser", ""), ...stations.map((s) => new Option(s.id, s.id)));
      approvals.append(h("div", { class: "filerow" },
        h("span", {}, `${j.id} · ${j.pupilId ?? ""} · ${j.preset.id}${j.estimate?.durationS ? ` · ${describeDuration(j.estimate.durationS)}` : ""}${j.warnings?.length ? ` · ⚠ ${j.warnings.join(" ")}` : ""}`),
        button("Approve", () => void act(() => approveJob(session, j.id, sel.value || undefined)), "go"), sel,
        button("Reject…", () => void (async () => {
          const v = await openDialog("Reject this file", [{ key: "reason", label: "Reason (the pupil sees this)", type: "text", value: "" }], { ok: "Reject" });
          if (v && String(v.reason).trim()) await act(() => rejectJob(session, j.id, String(v.reason).trim()));
        })())));
    }
    const q = h("div", {}, h("h3", {}, `Queue (${queue.length})`));
    if (!queue.length) q.append(h("p", { class: "hint" }, "The queue is empty."));
    for (const e of queue) {
      const row = h("div", { class: "filerow" }, h("span", {}, `#${e.ticket} · ${e.pupilId ?? ""} · ${e.presetId ?? ""} · ${e.status === "approved" ? `place ${e.position}` : STATUS_TEXT[e.status] ?? e.status}${e.station ? ` · ${e.station}` : ""}`));
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
