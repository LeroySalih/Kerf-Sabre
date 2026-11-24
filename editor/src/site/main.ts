// Kerf's public website: the landing page, /pricing and /sign-in (proprietary, part of the hosted Kerf service; see LICENSING.md).
// Fonts are bundled (Fontsource, SIL OFL 1.1): no request ever leaves for a font service.
import "@fontsource/lexend/latin-600.css";
import "@fontsource/lexend/latin-700.css";
import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "./site.css";
import { mountPanel } from "./panel";
import { mountRegister } from "./register";
import { otherTheme, readTheme, saveTheme, type Theme } from "./theme";

const store = (): Storage | null => { try { return localStorage; } catch { return null; } };

function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((b) => b.setAttribute("aria-pressed", t === "dark" ? "true" : "false"));
}

let theme = readTheme(store());
applyTheme(theme);
document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]").forEach((b) => b.addEventListener("click", () => {
  theme = otherTheme(theme);
  applyTheme(theme);
  saveTheme(store(), theme);
}));

const panel = document.querySelector<HTMLElement>("[data-signin-panel]");
if (panel) mountPanel(panel);
const register = document.querySelector<HTMLElement>("[data-register-panel]");
if (register) mountRegister(register);
