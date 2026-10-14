import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// start.py sets KERF_SERVER_URL for `npm run dev` so the dev server forwards /api to the Kerf Server (no CORS, no address to type).
const serverUrl = process.env.KERF_SERVER_URL;
const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Two pages: the Editor (/) and the teacher/admin site (/admin/).
  build: { rollupOptions: { input: { main: page("./index.html"), admin: page("./admin/index.html") } } },
  // Machine profiles live in ../shared and are imported at build time.
  server: { fs: { allow: [".."] }, ...(serverUrl ? { proxy: { "/api": { target: serverUrl, changeOrigin: true } } } : {}) },
  test: { include: ["tests/**/*.test.ts"] },
});
