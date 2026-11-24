// Kerf's public website (proprietary, part of the hosted service; see LICENSING.md): which address shows what.
// The Kerf Server does the same in server/kerf_server/webpages.py, and vite.config.ts does it for `npm run dev`. Tested in tests/site.test.ts.
//   /            the landing page        (site/index.html)
//   /pricing     the pricing page        (site/pricing.html)
//   /sign-in     one sign-in page for everyone (site/sign-in.html)
//   /editor/     the Kerf Editor         (index.html)
//   /admin/      the Admin site          (admin/index.html)

/** Queries that used to open the Editor at `/`: a Station link, DINO coming back, an emailed link, or "work without signing in". */
export const EDITOR_QUERY_KEYS = ["station", "code", "state", "error", "signin", "offline"] as const;

/** Where a request to `/` with this query must go instead of the landing page: the Editor, with the same query. Null: show the landing page. */
export function editorForward(search: string): string | null {
  const q = search.startsWith("?") ? search.slice(1) : search;
  if (!q) return null;
  const keys = new URLSearchParams(q);
  return EDITOR_QUERY_KEYS.some((k) => keys.has(k)) ? `/editor/?${q}` : null;
}

/** The built file for each site address (paths inside editor/dist; the same files are the Vite inputs). */
export const SITE_FILES: Record<string, string> = { "/": "site/index.html", "/pricing": "site/pricing.html", "/sign-in": "site/sign-in.html", "/editor/": "index.html" };
