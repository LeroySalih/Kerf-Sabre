// Kerf's own sign-ins for the Admin site, the Editor and the sign-in page (shared 0.2.47): staff sign in with school email +
// password (`passwordSignIn`); email only checks the address: an invite, a new school's confirmation or "Forgot your password?"
// (`askForReset`) sends a one-time link (`?signin=<token>` / `?register=<token>`) that the sign-in page trades together with the
// password the person chooses. Pupils sign in with their Pupil Card (`cardSignIn`). The session is kept for this tab only
// (sessionStorage), like a DINO sign-in, so closing the tab signs the person out. A password is never stored. Tested in
// tests/emailsignin.test.ts.
import { normaliseBase, request, type Session } from "./server";
import type { App } from "./sso";

type Fetch = typeof fetch;
const key = (app: App) => `kerf.email.${app}`;
interface Saved { token: string; baseUrl: string }

/** The link's token, if this page was opened from a sign-in email. */
export const readLinkToken = (search: string): string | null => {
  const t = new URLSearchParams(search).get("signin");
  return t && /^[A-Za-z0-9_-]{20,200}$/.test(t) ? t : null;
};

/** An emailed link opened on the Editor or the Admin site itself (older links): the sign-in page asks for the password, so send it there. */
export const signInPageForLink = (token: string, app: App): string => `/sign-in?signin=${encodeURIComponent(token)}&app=${app}`;

/** Take `signin=` (or a registration link's `register=`) out of the address so a reload or a bookmark never shows the (already used) link. */
export function cleanLinkFromAddress(loc: Location = location, hist: History = history): void {
  const q = new URLSearchParams(loc.search);
  q.delete("signin");
  q.delete("register");
  const rest = q.toString();
  try { hist.replaceState(null, "", `${loc.pathname}${rest ? `?${rest}` : ""}`); } catch { /* fine */ }
}

/** "Forgot your password?": ask the server to email a link to set a new password. The answer is the same whether or not the address has an account. */
export async function askForReset(baseUrl: string, email: string, app: App, f: Fetch = fetch): Promise<string> {
  const r = await request<{ message: string }>({ baseUrl: normaliseBase(baseUrl), token: "" }, "POST", "/auth/password/forgot", { email: email.trim(), app }, f);
  return r.message;
}

function keep(app: App, token: string, baseUrl: string, st: Storage): void {
  try { st.setItem(key(app), JSON.stringify({ token, baseUrl } satisfies Saved)); } catch { /* fine: it lasts until the page reloads */ }
}

/** Staff: sign in with school email + password, kept for this tab. `school` answers a `409 choose_school` (the same email and password at
 * several schools; `schoolChoices` in staffpassword.ts reads the list). Throws the server's message (wrong, locked, switched off). */
export async function passwordSignIn(app: App, baseUrl: string, login: { email: string; password: string; school?: string }, f: Fetch = fetch, st: Storage = sessionStorage): Promise<Session> {
  const base = normaliseBase(baseUrl);
  const r = await request<{ token: string; name?: string | null; expiresAt?: string }>({ baseUrl: base, token: "" }, "POST", "/auth/staff/login",
    { email: login.email.trim(), password: login.password, ...(login.school ? { school: login.school } : {}) }, f);
  const s = await sessionFrom(base, r.token, f);
  if (r.name) s.name = r.name;
  if (r.expiresAt) s.expiresAt = r.expiresAt;
  keep(app, r.token, base, st);
  return s;
}

/** A signed-in member of staff changes their Kerf password. Their other sessions end; this one stays. Returns the server's message. */
export async function changePassword(s: Session, current: string, next: string, f: Fetch = fetch): Promise<string> {
  return (await request<{ message: string }>(s, "POST", "/auth/password/change", { current, new: next }, f)).message;
}

async function sessionFrom(baseUrl: string, token: string, f: Fetch): Promise<Session> {
  const me = await request<{ role: string; id: string; school?: string | null; plan?: string | null; siteAdmin?: boolean; schoolCode?: string | null; features?: Session["features"]; limits?: Session["limits"]; name?: string | null; method?: string | null }>({ baseUrl, token }, "GET", "/auth/me", undefined, f);
  return { ...(me.name ? { name: me.name } : {}), ...(me.method === "password" ? { password: true } : {}), baseUrl, token, role: me.role, id: me.id, school: me.school, plan: me.plan, siteAdmin: me.siteAdmin, schoolCode: me.schoolCode, features: me.features, limits: me.limits, email: true };
}

/** An invite or reset link plus the password the person chose: the server sets it (ending their other sessions) and signs them in, kept
 * for this tab. Throws the server's message for a used or expired link (401) or a weak password (422, the link stays usable). */
export async function finishEmailSignIn(app: App, baseUrl: string, linkToken: string, password: string, f: Fetch = fetch, st: Storage = sessionStorage): Promise<Session> {
  const base = normaliseBase(baseUrl);
  const r = await request<{ token: string; name?: string | null; expiresAt?: string }>({ baseUrl: base, token: "" }, "POST", "/auth/email/finish", { token: linkToken, password }, f);
  const s = await sessionFrom(base, r.token, f);
  if (r.name) s.name = r.name;
  if (r.expiresAt) s.expiresAt = r.expiresAt;
  keep(app, r.token, base, st);
  return s;
}

/** A new school's registration link (shared 0.2.40) plus the admin's chosen password: the server makes the free school and its first
 * admin, and signs them in. The session is kept for this tab under the Admin site's key, so /admin/ picks it up. Throws the server's
 * message for a used or expired link or a weak password. */
export async function finishRegistration(baseUrl: string, linkToken: string, password: string, f: Fetch = fetch, st: Storage = sessionStorage): Promise<Session> {
  const base = normaliseBase(baseUrl);
  const r = await request<{ token: string; name?: string | null; expiresAt?: string }>({ baseUrl: base, token: "" }, "POST", "/auth/register/finish", { token: linkToken, password }, f);
  const s = await sessionFrom(base, r.token, f);
  if (r.name) s.name = r.name;
  if (r.expiresAt) s.expiresAt = r.expiresAt;
  keep("admin", r.token, base, st);
  return s;
}

/** A pupil signs in with their Pupil Card (school code, group code, pupil ID, two-word password; shared 0.2.47). The session is kept
 * for this tab like an emailed link's, under the Editor's key, so /editor/ picks it up. Throws the server's message when it is wrong. */
export async function cardSignIn(baseUrl: string, card: { schoolCode: string; groupCode: string; pupilId: string; password: string }, f: Fetch = fetch, st: Storage = sessionStorage): Promise<Session> {
  const base = normaliseBase(baseUrl);
  const r = await request<{ token: string; expiresAt?: string }>({ baseUrl: base, token: "" }, "POST", "/auth/pupil",
    { schoolCode: card.schoolCode.trim(), groupCode: card.groupCode.trim(), pupilId: card.pupilId.trim(), password: card.password }, f);
  const s = await sessionFrom(base, r.token, f);
  if (r.expiresAt) s.expiresAt = r.expiresAt;
  keep("editor", r.token, base, st);
  return s;
}

/** After a reload: the tab's email session, if it is still good. */
export async function restoreEmailSignIn(app: App, f: Fetch = fetch, st: Storage = sessionStorage): Promise<Session | null> {
  let saved: Saved | null = null;
  try { saved = JSON.parse(st.getItem(key(app)) ?? "null") as Saved | null; } catch { saved = null; }
  if (!saved?.token) return null;
  try { return await sessionFrom(saved.baseUrl ?? "", saved.token, f); } catch { try { st.removeItem(key(app)); } catch { /* fine */ } return null; }
}

/** Sign out: end the session on the server (best effort) and forget it in this tab. */
export async function endEmailSignIn(app: App, s: Session | null, f: Fetch = fetch, st: Storage = sessionStorage): Promise<void> {
  try { st.removeItem(key(app)); } catch { /* fine */ }
  if (s) { try { await f(`${s.baseUrl}/api/v1/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${s.token}` } }); } catch { /* it expires anyway */ } }
}
