import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { SITE_FILES, editorForward } from "./src/site/routes";

// start.py sets KERF_SERVER_URL for `npm run dev` so the dev server forwards /api to the Kerf Server (no CORS, no address to type).
const serverUrl = process.env.KERF_SERVER_URL;
const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** The public website (site/*.html) shares one sign-in panel: `<!-- include panel.html -->` pulls in site/partials/panel.html. */
const siteIncludes = (): Plugin => ({
  name: "kerf-site-includes",
  transformIndexHtml: {
    order: "pre",
    handler: (html) => html.replace(/<!-- include ([a-z-]+\.html) -->/g, (_m, f: string) => readFileSync(page(`./site/partials/${f}`), "utf8")),
  },
});

/** `npm run dev` answers the same addresses as the Kerf Server (src/site/routes.ts): / (or the Editor for its old queries), /pricing, /sign-in, /register, /editor/. */
const siteRoutes = (): Plugin => ({
  name: "kerf-site-routes",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const [path = "/", query = ""] = (req.url ?? "/").split("?", 2);
      if (path === "/") {
        const to = editorForward(query);
        if (to) { res.statusCode = 302; res.setHeader("Location", to); res.end(); return; }
      }
      if (path === "/editor") { res.statusCode = 301; res.setHeader("Location", `/editor/${query ? `?${query}` : ""}`); res.end(); return; }
      const file = SITE_FILES[path];
      if (file) req.url = `/${file}${query ? `?${query}` : ""}`;
      next();
    });
  },
});

export default defineConfig({
  plugins: [siteIncludes(), siteRoutes()],
  // The Editor (index.html, served at /editor/), the teacher/admin site (/admin/) and the public website (site/: /, /pricing, /sign-in, /register).
  build: { rollupOptions: { input: {
    main: page("./index.html"), admin: page("./admin/index.html"),
    site: page("./site/index.html"), pricing: page("./site/pricing.html"), signin: page("./site/sign-in.html"), register: page("./site/register.html"),
  } } },
  // Machine profiles live in ../shared and are imported at build time.
  server: { fs: { allow: [".."] }, ...(serverUrl ? { proxy: { "/api": { target: serverUrl, changeOrigin: true } } } : {}) },
  test: { include: ["tests/**/*.test.ts"] },
});
