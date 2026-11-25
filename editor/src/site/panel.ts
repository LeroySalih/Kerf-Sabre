// The sign-in panel on the landing page and on /sign-in (proprietary site code). It starts the Editor's or the Admin site's own
// sign-in (DINO; staff email + password; a Pupil Card) and, for an emailed link (invite, reset, registration), shows Choose a password
// and trades the link with that password before going on to /editor/ or /admin/, where the session is picked up again from this tab's
// sessionStorage. The decisions are in signinlogic.ts and ../staffpassword.ts (tested).
import { askForReset, cardSignIn, cleanLinkFromAddress, finishEmailSignIn, finishRegistration, passwordSignIn } from "../emailsignin";
import { ServerError } from "../server";
import { takeProblem } from "../signinpage";
import { beginSignIn, fetchAuthConfig } from "../sso";
import { RULES, checkForgot, checkNewPassword, checkSignIn, schoolChoices } from "../staffpassword";
import { destinationFor, dinoAppFor, emailAppFor, planSignIn, viewAfterLinkError, type Role, type View } from "./signinlogic";

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
    one<HTMLElement>("[data-foot]").hidden = v === "sent" || v === "busy" || v === "choose" || v === "pick";
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

  const busy = (b: HTMLButtonElement, on: boolean) => { if (on) b.setAttribute("aria-busy", "true"); else b.removeAttribute("aria-busy"); };
  // "Show password" ticks show the boxes they name
  for (const tick of all<HTMLInputElement>("[data-show-password]")) {
    tick.addEventListener("change", () => {
      for (const id of (tick.dataset.showPassword ?? "").split(" ")) { const box = root.querySelector<HTMLInputElement>(`#${id}`); if (box) box.type = tick.checked ? "text" : "password"; }
    });
  }

  // a reset link ("Forgot your password?", and the expired view's "Send me a new link"), then the sent view
  function sendReset(box: HTMLInputElement, go: HTMLButtonElement): void {
    const problem = checkForgot(box.value);
    if (problem) { alert(problem); box.focus(); return; }
    if (go.getAttribute("aria-busy")) return;
    busy(go, true);
    void askForReset(base(), box.value, emailAppFor(hint))
      .then(() => { show("sent", true); })
      .catch((e) => alert(text(e)))
      .finally(() => busy(go, false));
  }
  for (const form of all<HTMLFormElement>("[data-email-form]")) {
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      sendReset(form.querySelector<HTMLInputElement>("input[type=email]")!, form.querySelector<HTMLButtonElement>("button[type=submit]")!);
    });
  }

  // staff: school email + password
  const staff = one<HTMLFormElement>("[data-staff-form]");
  const staffEmail = staff.querySelector<HTMLInputElement>('[name="email"]')!;
  const staffPass = staff.querySelector<HTMLInputElement>('[name="password"]')!;
  const staffGo = staff.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const app = emailAppFor(hint);
  const signedIn = () => location.replace(destinationFor(app, app === "editor" ? station() : null));
  function staffSignIn(school?: string, from: HTMLButtonElement = staffGo): void {
    if (from.getAttribute("aria-busy")) return;
    busy(from, true);
    alert("");
    void passwordSignIn(app, base(), { email: staffEmail.value, password: staffPass.value, ...(school ? { school } : {}) })
      .then(signedIn)
      .catch((e) => {
        const choices = schoolChoices(e);
        if (choices) { pickSchool(choices); return; }
        if (view !== "form") show("form");
        alert(text(e));
        staffPass.select();
      })
      .finally(() => busy(from, false));
  }
  function pickSchool(choices: { school: string; name: string }[]): void {
    const list = one<HTMLElement>("[data-pick-list]");
    list.replaceChildren(...choices.map((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kp-sso";
      b.textContent = c.name;
      b.addEventListener("click", () => staffSignIn(c.school, b));
      return b;
    }));
    show("pick", true);
  }
  staff.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const problem = checkSignIn(staffEmail.value, staffPass.value);
    if (problem) { alert(problem.message); (problem.field === "email" ? staffEmail : staffPass).focus(); return; }
    staffSignIn();
  });
  const forgot = one<HTMLButtonElement>("[data-forgot]");
  forgot.addEventListener("click", () => sendReset(staffEmail, forgot));

  // "Sign in with Pupil Card" opens the card's four boxes underneath (and closes them again)
  const cardOpen = one<HTMLButtonElement>("[data-card-open]");
  const cardPanel = one<HTMLElement>("[data-card-panel]");
  cardOpen.addEventListener("click", () => {
    const open = cardPanel.hidden === true;
    cardPanel.hidden = !open;
    cardOpen.setAttribute("aria-expanded", String(open));
    cardOpen.classList.toggle("on", open);
    if (open) { cardPanel.querySelector<HTMLInputElement>("input")?.focus(); cardPanel.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  });

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
  for (const b of all<HTMLButtonElement>("[data-back-staff]")) b.addEventListener("click", () => { choose("staff"); show("form", true); });
  one<HTMLButtonElement>("[data-back-pupil]").addEventListener("click", () => { choose("pupil"); show("form", true); });

  choose(role);
  show(view);
  const problem = takeProblem();
  if (problem && view === "form") alert(problem);

  // Choose a password: the rules, then the link is traded together with the password
  one<HTMLElement>("[data-rules]").replaceChildren(...RULES.map((r) => { const li = document.createElement("li"); li.textContent = r; return li; }));
  if (plan.register) {
    // a new school's confirmation link: the views are worded for registering
    one<HTMLElement>('[data-view="choose"] .kp-title').textContent = "Confirm your school: choose a password";
    one<HTMLElement>("[data-choose-text]").textContent = "Your email address is checked. Choose the password you will sign in with as your school's Kerf admin. Then Kerf sets up your school.";
    one<HTMLElement>("[data-choose-go]").textContent = "Save password and set up my school";
    one<HTMLElement>('[data-view="busy"] .kp-title').textContent = "Setting up your school";
    one<HTMLElement>("[data-expired-text]").textContent = "That link has expired or has already been used. If you have already confirmed your school, sign in with your email and password. Otherwise, register again.";
    one<HTMLElement>("[data-register-again]").hidden = false;
  }
  if (plan.token) {
    const token = plan.token;
    const linkApp = plan.app ?? "admin";
    cleanLinkFromAddress(); // a reload or a bookmark never shows the link again
    const chooseForm = one<HTMLFormElement>("[data-choose-form]");
    const p1 = chooseForm.querySelector<HTMLInputElement>('[name="password"]')!;
    const p2 = chooseForm.querySelector<HTMLInputElement>('[name="repeat"]')!;
    const go = chooseForm.querySelector<HTMLButtonElement>("button[type=submit]")!;
    for (const box of [p1, p2]) box.addEventListener("input", () => alert(""));
    chooseForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const problem = checkNewPassword(p1.value, p2.value);
      if (problem) { alert(problem); (p1.value.length >= 10 && p2.value !== p1.value ? p2 : p1).focus(); return; }
      if (go.getAttribute("aria-busy")) return;
      busy(go, true);
      alert("");
      const done = plan.register ? finishRegistration(base(), token, p1.value) : finishEmailSignIn(linkApp, base(), token, p1.value);
      void done
        .then(() => location.replace(plan.register ? destinationFor("admin") : destinationFor(linkApp, linkApp === "editor" ? station() : null)))
        .catch((e) => {
          const next = e instanceof ServerError ? viewAfterLinkError(e.status, e.code) : "form";
          if (next === "expired") { show("expired"); return; }
          if (next === "choose") { alert(text(e)); p1.focus(); return; }
          choose("staff"); show("form"); alert(text(e));
        })
        .finally(() => busy(go, false));
    });
    if (view === "choose") p1.focus();
  }
}
