// The sign-in panel on the landing page and on /sign-in (proprietary site code). It starts the Editor's or the Admin site's own
// sign-in (DINO, or a link by email) and, for an emailed link, trades the link for a session before going on to /editor/ or /admin/,
// where the session is picked up again from this tab's sessionStorage. The decisions are in signinlogic.ts (tested).
import { askForLink, cardSignIn, cleanLinkFromAddress, finishEmailSignIn } from "../emailsignin";
import { ServerError } from "../server";
import { takeProblem } from "../signinpage";
import { beginSignIn, fetchAuthConfig } from "../sso";
import { destinationFor, dinoAppFor, emailAppFor, linkIsSpent, planSignIn, type Role, type View } from "./signinlogic";

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const base = (): string => (location.protocol.startsWith("http") ? location.origin : "");
const station = (): string | null => { try { return sessionStorage.getItem("kerf.station"); } catch { return null; } };

export function mountPanel(root: HTMLElement): void {
  const plan = planSignIn(location.search);
  const hint = plan.app;
  let role: Role = plan.role;
  let view: View = plan.view;
  const all = <T extends Element>(sel: string) => [...root.querySelectorAll<T>(sel)];
  const one = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const viewEl = (v: View) => one<HTMLElement>(`[data-view="${v}"]`);

  function alert(msg: string): void {
    for (const a of all<HTMLElement>("[data-alert]")) {
      const mine = viewEl(view).contains(a);
      a.textContent = mine ? msg : "";
      a.hidden = !mine || !msg;
    }
  }

  function show(v: View, focus = false): void {
    view = v;
    for (const el of all<HTMLElement>("[data-view]")) el.hidden = el.dataset.view !== v;
    one<HTMLElement>("[data-foot]").hidden = v === "sent" || v === "busy";
    // the panel is named by the heading of the view on show
    for (const h of all<HTMLElement>(".kp-title")) h.removeAttribute("id");
    const title = viewEl(v).querySelector<HTMLElement>(".kp-title");
    if (title) {
      title.id = "kerf-signin-title";
      if (focus) { title.tabIndex = -1; title.focus(); }
    }
    alert("");
  }

  function choose(r: Role): void {
    role = r;
    for (const b of all<HTMLButtonElement>("[data-role]")) b.setAttribute("aria-pressed", b.dataset.role === r ? "true" : "false");
    for (const p of all<HTMLElement>("[data-only]")) p.hidden = p.dataset.only !== r;
  }

  for (const b of all<HTMLButtonElement>("[data-role]")) b.addEventListener("click", () => { choose(b.dataset.role as Role); alert(""); });

  const dino = one<HTMLButtonElement>("[data-dino]");
  dino.addEventListener("click", () => void (async () => {
    alert("");
    dino.setAttribute("aria-busy", "true");
    try {
      const cfg = await fetchAuthConfig(base());
      if (!cfg.sso) throw new Error("Can't reach the server's DINO sign-in settings. Check your network and try again.");
      await beginSignIn(dinoAppFor(role, hint), base(), cfg.sso, location, (url) => location.assign(url));
    } catch (e) { alert(text(e)); dino.removeAttribute("aria-busy"); }
  })());

  for (const form of all<HTMLFormElement>("[data-email-form]")) {
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const box = form.querySelector<HTMLInputElement>("input[type=email]")!;
      if (!box.value.trim() || !box.checkValidity()) { box.reportValidity(); box.focus(); return; }
      const go = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
      if (go.getAttribute("aria-busy")) return;
      go.setAttribute("aria-busy", "true");
      void askForLink(base(), box.value, emailAppFor(hint))
        .then(() => { show("sent", true); })
        .catch((e) => alert(text(e)))
        .finally(() => go.removeAttribute("aria-busy"));
    });
  }
  const card = one<HTMLFormElement>("[data-pupil-card]");
  card.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const field = (n: string) => card.querySelector<HTMLInputElement>(`[name="${n}"]`)!;
    const empty = ["school", "group", "pupil", "password"].map(field).find((i) => !i.value.trim());
    if (empty) { alert("Fill in all four boxes from your Pupil Card."); empty.focus(); return; }
    const go = card.querySelector<HTMLButtonElement>("button[type=submit]")!;
    if (go.getAttribute("aria-busy")) return;
    go.setAttribute("aria-busy", "true");
    alert("");
    void cardSignIn(base(), { schoolCode: field("school").value, groupCode: field("group").value, pupilId: field("pupil").value, password: field("password").value })
      .then(() => location.replace(destinationFor("editor", station())))
      .catch((e) => { alert(text(e)); field("password").select(); })
      .finally(() => go.removeAttribute("aria-busy"));
  });
  one<HTMLButtonElement>("[data-back-staff]").addEventListener("click", () => { choose("staff"); show("form", true); });
  one<HTMLButtonElement>("[data-back-pupil]").addEventListener("click", () => { choose("pupil"); show("form", true); });

  choose(role);
  show(view);
  const problem = takeProblem();
  if (problem && view === "form") alert(problem);

  if (plan.token) {
    const app = plan.app ?? "admin";
    const token = plan.token;
    cleanLinkFromAddress(); // a reload or a bookmark never reuses the (now used) link
    void finishEmailSignIn(app, base(), token)
      .then(() => location.replace(destinationFor(app, app === "editor" ? station() : null)))
      .catch((e) => {
        if (e instanceof ServerError && linkIsSpent(e.status)) { show("expired"); return; }
        choose("staff"); show("form"); alert(text(e));
      });
  }
}
