// Sign in with DINO (planner-004): Authorization Code + PKCE (S256) from the browser. See docs/AUTH-PLANNER-004.md.
// The access token (a short-lived JWT) lives in memory only; the rotating refresh token lives in sessionStorage, so it
// goes when the tab closes. Nothing here stores a name or email. The server checks every token; this only gets and renews them.
import { normaliseBase, request, type Session } from "./server";

export interface SsoConfig {
  issuer: string; authorizeUrl: string; tokenUrl: string; revokeUrl: string; userinfoUrl?: string;
  clientIds: { editor: string; admin: string }; scopes: string[];
}
export interface AuthConfig { mode: "pins" | "planner" | "both"; sso: SsoConfig | null }
export type App = "editor" | "admin";
type Fetch = typeof fetch;
export interface Tokens { accessToken: string; refreshToken: string | null; expiresAt: number }

export class SsoError extends Error {}

/** How this server wants people to sign in. An older server (or any failure) means the class code + PIN page. */
export async function fetchAuthConfig(baseUrl: string, f: Fetch = fetch): Promise<AuthConfig> {
  try {
    const res = await f(`${normaliseBase(baseUrl)}/api/v1/auth/config`);
    if (!res.ok) return { mode: "pins", sso: null };
    const c = (await res.json()) as Partial<AuthConfig>;
    const ok = c.sso && typeof c.sso.authorizeUrl === "string" && typeof c.sso.tokenUrl === "string" && c.sso.clientIds;
    if ((c.mode === "planner" || c.mode === "both") && ok) return { mode: c.mode, sso: c.sso as SsoConfig };
  } catch { /* offline or not JSON */ }
  return { mode: "pins", sso: null };
}

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomString = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export const pkceChallenge = async (verifier: string): Promise<string> => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

/** This page's own address without any query: the registered redirect URI (`<origin>/` for the Editor, `<origin>/admin/` for Admin). */
export const redirectUriFor = (loc: { origin: string; pathname: string }): string => loc.origin + loc.pathname;

export function buildAuthorizeUrl(a: { cfg: SsoConfig; clientId: string; redirectUri: string; challenge: string; state: string; scope?: string }): string {
  const u = new URL(a.cfg.authorizeUrl);
  const p = u.searchParams;
  p.set("response_type", "code"); p.set("client_id", a.clientId); p.set("redirect_uri", a.redirectUri);
  p.set("code_challenge", a.challenge); p.set("code_challenge_method", "S256"); p.set("state", a.state);
  const scope = a.scope ?? a.cfg.scopes.join(" ");
  if (scope) p.set("scope", scope);
  return u.toString();
}

export type Callback = { code: string; state: string } | { error: string; description: string } | null;
/** What DINO sent the browser back with, or null when this is an ordinary page load. */
export function readCallback(search: string): Callback {
  const p = new URLSearchParams(search);
  const state = p.get("state");
  if (p.get("error")) return { error: p.get("error")!, description: p.get("error_description") ?? "" };
  const code = p.get("code");
  return code && state ? { code, state } : null;
}

const pendingKey = (app: App) => `kerf.sso.pending.${app}`;
const savedKey = (app: App) => `kerf.sso.refresh.${app}`;
interface Pending { verifier: string; state: string; baseUrl: string; cfg: SsoConfig }
interface Saved { refreshToken: string; baseUrl: string; cfg: SsoConfig }
const read = <T>(st: Storage, k: string): T | null => { try { return JSON.parse(st.getItem(k) ?? "null") as T | null; } catch { return null; } };
const write = (st: Storage, k: string, v: unknown | null): void => { try { if (v === null) st.removeItem(k); else st.setItem(k, JSON.stringify(v)); } catch { /* private window: signed in for this page only */ } };

/** Send the browser to DINO. Comes back to this same page with ?code=&state=. */
export async function beginSignIn(app: App, baseUrl: string, cfg: SsoConfig, loc: { origin: string; pathname: string }, go: (url: string) => void, st: Storage = sessionStorage): Promise<void> {
  const verifier = randomString(48), state = randomString(24);
  write(st, pendingKey(app), { verifier, state, baseUrl: normaliseBase(baseUrl), cfg } satisfies Pending);
  go(buildAuthorizeUrl({ cfg, clientId: cfg.clientIds[app], redirectUri: redirectUriFor(loc), challenge: await pkceChallenge(verifier), state }));
}

const tokensFrom = (j: Record<string, unknown>, now: number, keepRefresh: string | null): Tokens => {
  if (typeof j.access_token !== "string") throw new SsoError("DINO did not send a sign-in token.");
  const refresh = typeof j.refresh_token === "string" ? j.refresh_token : keepRefresh;
  return { accessToken: j.access_token, refreshToken: refresh, expiresAt: now + (typeof j.expires_in === "number" ? j.expires_in : 900) * 1000 };
};

async function tokenRequest(cfg: SsoConfig, form: Record<string, string>, f: Fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(cfg.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  } catch { throw new SsoError("Can't reach DINO to sign you in. Check your network."); }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new SsoError(typeof j.error_description === "string" ? j.error_description : "DINO refused the sign-in. Try again.");
  return j;
}

/** Called on the page DINO returned to. Returns the session, or null if this is not a sign-in return. Throws SsoError with a readable message. */
export async function finishSignIn(app: App, search: string, loc: { origin: string; pathname: string }, f: Fetch = fetch, st: Storage = sessionStorage, now = Date.now()): Promise<{ session: Session; tokens: Tokens } | null> {
  const cb = readCallback(search);
  if (!cb) return null;
  const pending = read<Pending>(st, pendingKey(app));
  write(st, pendingKey(app), null); // a sign-in attempt is used once
  if ("error" in cb) throw new SsoError(cb.error === "access_denied" ? "Sign-in was cancelled." : `DINO would not sign you in${cb.description ? `: ${cb.description}` : "."}`);
  if (!pending || pending.state !== cb.state) throw new SsoError("That sign-in did not start here, or it took too long. Start again.");
  const tokens = tokensFrom(await tokenRequest(pending.cfg, { grant_type: "authorization_code", code: cb.code, client_id: pending.cfg.clientIds[app], redirect_uri: redirectUriFor(loc), code_verifier: pending.verifier }, f), now, null);
  const session = await sessionFor(app, pending.baseUrl, tokens, f);
  if (tokens.refreshToken) write(st, savedKey(app), { refreshToken: tokens.refreshToken, baseUrl: pending.baseUrl, cfg: pending.cfg } satisfies Saved);
  return { session, tokens };
}

async function sessionFor(_app: App, baseUrl: string, tokens: Tokens, f: Fetch): Promise<Session> {
  const me = await request<{ role: string; id: string; school?: string | null }>({ baseUrl, token: tokens.accessToken }, "GET", "/auth/me", undefined, f);
  return { baseUrl, token: tokens.accessToken, role: me.role, id: me.id, school: me.school, sso: true };
}

/** After a page reload: trade this tab's refresh token for a fresh session. Null if there is none (or DINO says no). */
export async function restoreSignIn(app: App, f: Fetch = fetch, st: Storage = sessionStorage, now = Date.now()): Promise<{ session: Session; tokens: Tokens } | null> {
  const saved = read<Saved>(st, savedKey(app));
  if (!saved) return null;
  try {
    const tokens = tokensFrom(await tokenRequest(saved.cfg, { grant_type: "refresh_token", refresh_token: saved.refreshToken, client_id: saved.cfg.clientIds[app] }, f), now, saved.refreshToken);
    write(st, savedKey(app), { ...saved, refreshToken: tokens.refreshToken ?? saved.refreshToken } satisfies Saved);
    return { session: await sessionFor(app, saved.baseUrl, tokens, f), tokens };
  } catch { write(st, savedKey(app), null); return null; }
}

/** Keeps a DINO session alive: renews the access token a minute before it runs out and updates `session.token` in place. */
export class Renewer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private app: App, private session: Session, private tokens: Tokens, private onLost: (why: string) => void,
              private f: Fetch = fetch, private st: Storage = sessionStorage, private now: () => number = Date.now, private setT: typeof setTimeout = setTimeout, private clearT: typeof clearTimeout = clearTimeout) {
    this.schedule();
  }
  private schedule(): void {
    if (this.stopped) return;
    const wait = Math.max(1_000, this.tokens.expiresAt - this.now() - 60_000);
    this.timer = this.setT(() => void this.renew(), wait);
  }
  /** Renew right now (also used when a tab wakes up after sleeping). */
  async renew(): Promise<void> {
    const saved = read<Saved>(this.st, savedKey(this.app));
    if (this.stopped) return;
    if (!saved) return this.lost("Your DINO sign-in ended. Sign in again.");
    try {
      const t = tokensFrom(await tokenRequest(saved.cfg, { grant_type: "refresh_token", refresh_token: saved.refreshToken, client_id: saved.cfg.clientIds[this.app] }, this.f), this.now(), saved.refreshToken);
      if (this.stopped) return;
      this.tokens = t;
      this.session.token = t.accessToken;
      write(this.st, savedKey(this.app), { ...saved, refreshToken: t.refreshToken ?? saved.refreshToken } satisfies Saved);
      this.schedule();
    } catch (e) {
      if (e instanceof SsoError && /reach DINO/.test(e.message)) { this.timer = this.setT(() => void this.renew(), 15_000); return; } // offline: try again soon
      this.lost("Your DINO sign-in ended. Sign in again.");
    }
  }
  private lost(why: string): void { this.stop(); write(this.st, savedKey(this.app), null); this.onLost(why); }
  stop(): void { this.stopped = true; if (this.timer) this.clearT(this.timer); this.timer = null; }
}

/** Sign out: tell DINO to end this connection (best effort) and forget it here. */
export async function endSignIn(app: App, f: Fetch = fetch, st: Storage = sessionStorage): Promise<void> {
  const saved = read<Saved>(st, savedKey(app));
  write(st, savedKey(app), null);
  if (!saved) return;
  try {
    await f(saved.cfg.revokeUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: saved.refreshToken, token_type_hint: "refresh_token", client_id: saved.cfg.clientIds[app] }).toString() });
  } catch { /* offline: it expires */ }
}

/** Remove ?code=&state= from the address bar after a sign-in return. */
export const cleanAddress = (): void => { try { history.replaceState(null, "", location.pathname); } catch { /* fine */ } };
