// The site's light/dark switch (proprietary site code). Light unless the person chose dark; the choice is kept in localStorage.
export type Theme = "light" | "dark";
export const THEME_KEY = "kerf.site.theme";

export function readTheme(st: Storage | null): Theme {
  try { return st?.getItem(THEME_KEY) === "dark" ? "dark" : "light"; } catch { return "light"; }
}
export function saveTheme(st: Storage | null, t: Theme): void {
  try { st?.setItem(THEME_KEY, t); } catch { /* private window: it lasts until the page is left */ }
}
export const otherTheme = (t: Theme): Theme => (t === "dark" ? "light" : "dark");
