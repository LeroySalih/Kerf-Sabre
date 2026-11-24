// The Kerf Server's one sign-in page. When the Kerf Server serves the Editor (at /editor/) or the Admin site (at /admin/), it adds
// <meta name="kerf-sign-in" content="/sign-in"> to the page, and a signed-out person is sent there instead of seeing this page's own
// sign-in screen. Without that marker (Vite's dev server, a file, the Editor used on its own with no server) nothing changes.
// Tested in tests/site.test.ts.
import type { App } from "./sso";

export const SIGN_IN_META = "kerf-sign-in";
/** A message for the sign-in page to show (why the last sign-in did not work). This tab only; read once. */
export const PROBLEM_KEY = "kerf.site.problem";

/** The sign-in page's address for this app, from the marker's content; null when there is no usable marker. Only a same-site path is taken. */
export function signInPageFor(app: App, content: string | null | undefined): string | null {
  const c = (content ?? "").trim();
  if (!/^\/[A-Za-z0-9/_-]*$/.test(c) || c.startsWith("//")) return null;
  return `${c}?app=${app}`;
}

/** The marker on this page, if the Kerf Server put one there. */
export const readSignInMeta = (doc: Document = document): string | null =>
  doc.querySelector<HTMLMetaElement>(`meta[name="${SIGN_IN_META}"]`)?.content ?? null;

/** Go to the sign-in page, leaving it a message to show (if any). `expired`: an emailed link did not work. */
export function goToSignInPage(url: string, problem = "", opts: { expired?: boolean; st?: Storage; go?: (u: string) => void } = {}): void {
  const st = opts.st ?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined);
  try { if (problem && st) st.setItem(PROBLEM_KEY, problem); } catch { /* fine: the page shows no message */ }
  (opts.go ?? ((u: string) => location.replace(u)))(opts.expired ? `${url}&link=expired` : url);
}

/** The message left for the sign-in page, removed as it is read. */
export function takeProblem(st: Storage = sessionStorage): string {
  try { const p = st.getItem(PROBLEM_KEY) ?? ""; st.removeItem(PROBLEM_KEY); return p.slice(0, 400); } catch { return ""; }
}
