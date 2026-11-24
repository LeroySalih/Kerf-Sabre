// The sign-in page's decisions, without the page (proprietary site code; tested in tests/site.test.ts).
import type { App } from "../sso";

export type Role = "pupil" | "staff";
export type View = "form" | "busy" | "sent" | "expired";
export interface Plan {
  /** What the panel shows first. "busy": an emailed link is being traded for a session. */
  view: View;
  /** The tab that is chosen first. */
  role: Role;
  /** Which part of Kerf sent the person here (`?app=`), or the app an emailed link is for. Null: they came to /sign-in themselves. */
  app: App | null;
  /** The emailed link's token, when the page was opened from a sign-in email (or a registration email). */
  token: string | null;
  /** The token is a new school's registration link (`?register=<token>`, shared 0.2.40): it makes the school, then opens the Admin site. */
  register: boolean;
}

const asApp = (v: string | null): App | null => (v === "editor" || v === "admin" ? v : null);
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

/** What to show for this address: `?register=<token>` (a new school's confirmation link: always the Admin site), `?signin=<token>&app=…`
 * (an emailed link), `?link=expired`, `?app=editor|admin` (sent here by the Editor or the Admin site). */
export function planSignIn(search: string): Plan {
  const q = new URLSearchParams(search);
  const app = asApp(q.get("app"));
  const reg = q.get("register");
  if (reg !== null) {
    const token = TOKEN.test(reg) ? reg : null;
    return { view: token ? "busy" : "expired", role: "staff", app: "admin", token, register: true };
  }
  const raw = q.get("signin");
  if (raw !== null) {
    const token = TOKEN.test(raw) ? raw : null;
    return { view: token ? "busy" : "expired", role: "staff", app: app ?? "admin", token, register: false };
  }
  if (q.get("link") === "expired") return { view: "expired", role: "staff", app: app ?? "admin", token: null, register: false };
  return { view: "form", role: app === "admin" ? "staff" : "pupil", app, token: null, register: false };
}

/** Whose DINO sign-in a button starts. Pupils always use the Editor's. Staff use the Admin site's, unless the Editor sent them here. */
export const dinoAppFor = (role: Role, hint: App | null): App => (role === "pupil" ? "editor" : hint ?? "admin");

/** Which app an emailed link should open: the Admin site, unless the Editor sent the person here. */
export const emailAppFor = (hint: App | null): App => hint ?? "admin";

/** Where a person goes once signed in. The Editor gets back the laser of a Station link the person followed before signing in. */
export function destinationFor(app: App, station: string | null = null): string {
  if (app === "admin") return "/admin/";
  return station ? `/editor/?station=${encodeURIComponent(station)}` : "/editor/";
}

/** "Work without signing in": the Editor, in its offline mode. */
export const OFFLINE_EDITOR = "/editor/?offline=1";

/** A used, expired or made-up link (the server says 401 or 4xx), as opposed to the network failing. */
export const linkIsSpent = (status: number | undefined): boolean => status !== undefined && status >= 400 && status < 500;
