// Kerf Admin: the teacher and school-admin site (and, for the platform owner, the list of schools).
// It talks to the same server API as the Editor. Pupils never see it; a token decides which pages and which school's data you get.
import "../style.css";
import "./admin.css";
import { btn, el, msg } from "../dom";
import { ServerError, request, type Session } from "../server";
import { pagesFor, platformPages, type Ctx, type Page } from "./pages";
import { askForReset, cleanLinkFromAddress, endEmailSignIn, passwordSignIn, readLinkToken, restoreEmailSignIn, signInPageForLink } from "../emailsignin";
import { checkForgot, checkSignIn, schoolChoices } from "../staffpassword";
import { openChangePassword } from "./changepassword";
import { goToSignInPage, readSignInMeta, signInPageFor } from "../signinpage";
import { Renewer, beginSignIn, cleanAddress, endSignIn, fetchAuthConfig, finishSignIn, readCallback, restoreSignIn, type Tokens } from "../sso";

const KEY = "kerf.admin.session"; // an older version kept a pasted token here; nothing is stored any more
const saveSession = (_s: Session | null): void => { try { localStorage.removeItem(KEY); } catch { /* fine */ } };

const root = document.getElementById("admin")!;
let session: Session | null = null;
let renewer: Renewer | null = null;
/** A DINO sign-in is kept fresh in the background; if DINO ends it, back to the sign-in page. */
const keepAlive = (s: Session, tokens: Tokens): void => {
  renewer?.stop();
  renewer = new Renewer("admin", s, tokens, (why) => { stopPage(); renewer = null; session = null; saveSession(null); signInView(why); });
};
/** Only staff belong here, however they signed in. */
function staffOnly(me: { role: string }): void {
  if (!["teacher", "admin", "technician", "platform"].includes(me.role)) throw new ServerError(me.role === "station" ? "That is a laser station token. Station pages are for technicians and admins signing in with DINO." : "This site is for teachers, technicians and school admins. Pupils use the Editor.", 403, "forbidden");
}
let schoolName = "";
let stopPage: () => void = () => {};
/** The Kerf Server's one sign-in page, when it served this site (null under Vite's dev server: the card below is used instead). */
const siteSignIn = signInPageFor("admin", readSignInMeta());

function signInView(error = "", expired = false): void {
  stopPage();
  if (siteSignIn) { root.replaceChildren(); return goToSignInPage(siteSignIn, error, { expired }); }
  const err = el("p", { class: "ad-err", role: "alert" }, error);
  const url = el("input", { type: "text", placeholder: "Leave blank unless told otherwise" });
  (url as HTMLInputElement).value = location.protocol.startsWith("http") && location.port !== "5173" ? location.origin : "";
  const dino = el("button", { type: "submit", class: "on" }, "Sign in with DINO");
  // staff with a Kerf account: school email + password (and "Forgot your password?", which emails a link to choose a new one)
  const email = el("input", { type: "email", placeholder: "you@school.org", "aria-label": "Your school email address", autocomplete: "username" }) as HTMLInputElement;
  const password = el("input", { type: "password", placeholder: "Password", "aria-label": "Your password", autocomplete: "current-password" }) as HTMLInputElement;
  const sent = el("p", { class: "hint", role: "status" });
  const schools = el("div", { class: "ad-email" });
  const signIn = el("button", { type: "button" }, "Sign in with email and password");
  const tryPassword = (school?: string) => void (async () => {
    const problem = checkSignIn(email.value, password.value);
    if (problem) { err.textContent = problem.message; (problem.field === "email" ? email : password).focus(); return; }
    try {
      const s = await passwordSignIn("admin", (url as HTMLInputElement).value, { email: email.value, password: password.value, ...(school ? { school } : {}) });
      staffOnly(s); session = s; await shell();
    } catch (e) {
      const choices = schoolChoices(e);
      if (choices) {
        err.textContent = "";
        schools.replaceChildren(el("p", { class: "hint" }, "You have accounts at more than one school. Choose one:"), ...choices.map((c) => btn(c.name, () => tryPassword(c.school))));
        return;
      }
      err.textContent = msg(e); password.select();
    }
  })();
  signIn.addEventListener("click", () => tryPassword());
  password.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); tryPassword(); } });
  email.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); password.focus(); } });
  const forgot = el("button", { type: "button", class: "link" }, "Forgot your password?");
  forgot.addEventListener("click", () => void (async () => {
    const problem = checkForgot(email.value);
    if (problem) { err.textContent = problem; email.focus(); return; }
    try { sent.textContent = await askForReset((url as HTMLInputElement).value, email.value, "admin"); err.textContent = ""; } catch (e) { err.textContent = msg(e); }
  })());
  const form = el("form", { class: "ad-card ad-signin" }, el("h1", {}, "Kerf Admin"),
    el("p", { class: "hint" }, "Classes, pupils, activities, the queue and stations. Sign in with DINO, or with your school email and password."),
    el("details", {}, el("summary", {}, "Server address"), url), err, dino,
    el("div", { class: "ad-email" }, el("p", { class: "hint" }, "No DINO account? Your school admin invites you by email and you choose a password. Signed in with an emailed link before? Use Forgot your password? once."),
      email, password, signIn, forgot, schools, sent),
    el("a", { href: "/editor/" }, "Looking for the Editor?"));
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void (async () => {
      try {
        const c = await fetchAuthConfig((url as HTMLInputElement).value);
        if (!c.sso) throw new Error("Can't reach the server's DINO sign-in settings. Check the address and your network.");
        await beginSignIn("admin", (url as HTMLInputElement).value, c.sso, location, (u) => location.assign(u));
      } catch (e) { signInView(msg(e)); }
    })();
  });
  root.replaceChildren(form);
}

function signOut(): void {
  stopPage();
  if (session?.sso) void endSignIn("admin");
  if (session?.email) void endEmailSignIn("admin", session);
  renewer?.stop(); renewer = null;
  session = null;
  saveSession(null);
  signInView();
}

async function shell(): Promise<void> {
  if (!session) return signInView();
  const s = session;
  schoolName = "";
  if ((s.role === "teacher" || s.role === "admin") && !(s.siteAdmin && (() => { try { return sessionStorage.getItem("kerf.admin.site") === "platform"; } catch { return false; } })())) {
    try { schoolName = (await request<{ name: string }>(s, "GET", "/school")).name; }
    catch (e) {
      if (e instanceof ServerError && e.status === 401) { session = null; saveSession(null); return signInView("Your sign-in is no longer valid. Sign in again."); }
      throw e;
    }
  }
  // A site admin can switch between the Platform site (all schools) and their own school's admin pages.
  let site: "platform" | "school" = s.role === "platform" ? "platform" : "school";
  try { if (s.siteAdmin && sessionStorage.getItem("kerf.admin.site") === "platform") site = "platform"; } catch { /* fine */ }
  const platform = site === "platform";
  const pages = platform ? platformPages() : pagesFor(s.role, s.features ?? s.plan);
  if (!pages.length) {
    root.replaceChildren(el("div", { class: "ad-card ad-signin" }, el("h1", {}, "Kerf Admin"),
      el("p", {}, "Your school is on Kerf's free plan, which has no Station pages. Ask your school's admin about the paid plan."), btn("Sign out", signOut)));
    return;
  }
  const switchSite = (to: "platform" | "school") => { try { sessionStorage.setItem("kerf.admin.site", to); } catch { /* fine */ } void shell(); };
  const main = el("main", { class: "ad-main" });
  const nav = el("nav", { class: "ad-nav", "aria-label": "Admin pages" });
  let current: Page = pages[0]!;

  const ctx: Ctx = { session: s, school: schoolName, go: (key) => { const p = pages.find((x) => x.key === key); if (p) show(p); },
    renamed: (name) => { schoolName = name; ctx.school = name; whoText.textContent = whoLine(); } };
  function show(p: Page): void {
    stopPage();
    current = p;
    try { localStorage.setItem("kerf.admin.page", p.key); } catch { /* fine */ }
    nav.replaceChildren(...pages.map((x) => btn(x.title, () => show(x), x === current ? "on" : "")));
    main.replaceChildren(el("h1", {}, p.title), el("p", { class: "lead" }, p.lead));
    const body = el("div");
    main.append(body);
    const stop = p.mount(body, ctx);
    stopPage = typeof stop === "function" ? stop : () => {};
  }

  // the person's name (from DINO or their staff account), else their ID; the ID stays on hover. DINO's name can arrive a moment later.
  const whoName = el("span", { title: s.id }, s.name ?? s.id);
  // the school's name leads the line; a rename on the School page updates it without a reload (ctx.renamed)
  const whoLine = () => platform ? `Site admin: ${s.name ?? s.id}` : `${schoolName ? schoolName + " · " : ""}${s.schoolCode ? `school code ${s.schoolCode} · ` : ""}${s.plan === "free" ? "Free plan · " : ""}${s.role === "admin" ? "School admin" : s.role === "technician" ? "Technician" : "Teacher"}: `;
  const whoText = el("span", {}, whoLine());
  window.addEventListener("kerf-profile", () => { whoName.textContent = s.name ?? s.id; });
  const head = el("header", { class: `ad-head${platform ? " ad-platform" : ""}` }, el("span", { class: "brand" }, platform ? "Kerf Platform" : "Kerf Admin"),
    el("span", { class: "who" }, whoText, whoName), el("span", { class: "spacer" }),
    ...(s.siteAdmin && s.role !== "platform" ? [btn(platform ? "My school" : "Kerf Platform", () => switchSite(platform ? "school" : "platform"))] : []),
    ...(s.role === "teacher" || s.role === "admin" ? [el("a", { class: "btnlink", href: "/editor/" }, "Editor")] : []),
    ...(s.password ? [btn("Change password…", () => void openChangePassword(s))] : []), btn("Sign out", signOut));
  root.replaceChildren(head, nav, main);
  let saved = "";
  try { saved = localStorage.getItem("kerf.admin.page") ?? ""; } catch { /* fine */ }
  if (!pages.some((p) => p.key === saved)) saved = "";
  show(pages.find((p) => p.key === saved) ?? pages[0]!);
}

/** Back from DINO (?code=&state=), or a reload of a tab signed in with DINO. */
async function start(): Promise<void> {
  const link = readLinkToken(location.search);
  if (link) { // an older invite or sign-in email opened here: the sign-in page asks for the password first
    cleanLinkFromAddress();
    return location.replace(signInPageForLink(link, "admin"));
  }
  if (!session) {
    const s = await restoreEmailSignIn("admin");
    if (s) { try { staffOnly(s); session = s; } catch (e) { void endEmailSignIn("admin", s); return signInView(msg(e)); } }
  }
  if (readCallback(location.search)) {
    try {
      const r = await finishSignIn("admin", location.search, location);
      cleanAddress();
      if (r) { staffOnly(r.session); session = r.session; keepAlive(r.session, r.tokens); return void (await shell()); }
    } catch (e) {
      cleanAddress();
      void endSignIn("admin");
      return signInView(msg(e));
    }
  }
  if (!session) {
    const r = await restoreSignIn("admin");
    if (r) {
      try { staffOnly(r.session); session = r.session; keepAlive(r.session, r.tokens); } catch (e) { void endSignIn("admin"); return signInView(msg(e)); }
    }
  }
  if (session) await shell(); else signInView();
}
void start().catch((e) => signInView(msg(e)));
