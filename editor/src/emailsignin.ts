// Staff sign-in with an emailed link (shared 0.2.40), for the Admin site and the Editor. The link brings the browser back to
// the same page with `?signin=<token>`; the token is traded once for an ordinary session token. That session is kept for
// this tab only (sessionStorage), like a DINO sign-in, so closing the tab signs the person out. Tested in tests/emailsignin.test.ts.
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

/** Take `signin=` (or a registration link's `register=`) out of the address so a reload or a bookmark never shows the (already used) link. */
export function cleanLinkFromAddress(loc: Location = location, hist: History = history): void {
  const q = new URLSearchParams(loc.search);
  q.delete("signin");
  q.delete("register");
  const rest = q.toString();
  try { hist.replaceState(null, "", `${loc.pathname}${rest ? `?${rest}` : ""}`); } catch { /* fine */ }
}

/** Ask the server to email a sign-in link. The answer is the same whether or not the address has an account. */
export async function askForLink(baseUrl: string, email: string, app: App, f: Fetch = fetch): Promise<string> {
  const r = await request<{ message: string }>({ baseUrl: normaliseBase(baseUrl), token: "" }, "POST", "/auth/email/start", { email: email.trim(), app }, f);
  return r.message;
}

async function sessionFrom(baseUrl: string, token: string, f: Fetch): Promise<Session> {
  const me = await request<{ role: string; id: string; school?: string | null; plan?: string | null; siteAdmin?: boolean; schoolCode?: string | null; features?: Session["features"]; limits?: Session["limits"] }>({ baseUrl, token }, "GET", "/auth/me", undefined, f);
  return { baseUrl, token, role: me.role, id: me.id, school: me.school, plan: me.plan, siteAdmin: me.siteAdmin, schoolCode: me.schoolCode, features: me.features, limits: me.limits, email: true };
}

/** Trade the link's token for a session and keep it for this tab. Throws the server's message for a used or expired link. */
export async function finishEmailSignIn(app: App, baseUrl: string, linkToken: string, f: Fetch = fetch, st: Storage = sessionStorage): Promise<Session> {
  const base = normaliseBase(baseUrl);
  const r = await request<{ token: string; name?: string | null; expiresAt?: string }>({ baseUrl: base, token: "" }, "POST", "/auth/email/finish", { token: linkToken }, f);
  const s = await sessionFrom(base, r.token, f);
  if (r.name) s.name = r.name;
  if (r.expiresAt) s.expiresAt = r.expiresAt;
  try { st.setItem(key(app), JSON.stringify({ token: r.token, baseUrl: base } satisfies Saved)); } catch { /* fine: it lasts until the page reloads */ }
  return s;
}

/** A new school's registration link (shared 0.2.40): the server makes the free school and its first admin, and signs them in. The
 * session is kept for this tab under the Admin site's key, so /admin/ picks it up. Throws the server's message for a used or expired link. */
export async function finishRegistration(baseUrl: string, linkToken: string, f: Fetch = fetch, st: Storage = sessionStorage): Promise<Session> {
  const base = normaliseBase(baseUrl);
  const r = await request<{ token: string; name?: string | null; expiresAt?: string }>({ baseUrl: base, token: "" }, "POST", "/auth/register/finish", { token: linkToken }, f);
  const s = await sessionFrom(base, r.token, f);
  if (r.name) s.name = r.name;
  if (r.expiresAt) s.expiresAt = r.expiresAt;
  try { st.setItem(key("admin"), JSON.stringify({ token: r.token, baseUrl: base } satisfies Saved)); } catch { /* fine: it lasts until the page reloads */ }
  return s;
}

/** A pupil signs in with their Pupil Card (school code, group code, pupil ID, two-word password; shared 0.2.40). The session is kept
 * for this tab like an emailed link's, under the Editor's key, so /editor/ picks it up. Throws the server's message when it is wrong. */
export async function cardSignIn(baseUrl: string, card: { schoolCode: string; groupCode: string; pupilId: string; password: string }, f: Fetch = fetch, st: Storage = sessionStorage): Promise<Session> {
  const base = normaliseBase(baseUrl);
  const r = await request<{ token: string; expiresAt?: string }>({ baseUrl: base, token: "" }, "POST", "/auth/pupil",
    { schoolCode: card.schoolCode.trim(), groupCode: card.groupCode.trim(), pupilId: card.pupilId.trim(), password: card.password }, f);
  const s = await sessionFrom(base, r.token, f);
  if (r.expiresAt) s.expiresAt = r.expiresAt;
  try { st.setItem(key("editor"), JSON.stringify({ token: r.token, baseUrl: base } satisfies Saved)); } catch { /* fine: it lasts until the page reloads */ }
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
