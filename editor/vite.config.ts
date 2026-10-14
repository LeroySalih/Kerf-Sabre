import { defineConfig } from "vitest/config";

// start.py sets KERF_SERVER_URL for `npm run dev` so the dev server forwards /api to the Kerf Server (no CORS, no address to type).
const serverUrl = process.env.KERF_SERVER_URL;

export default defineConfig({
  // Machine profiles live in ../shared and are imported at build time.
  server: { fs: { allow: [".."] }, ...(serverUrl ? { proxy: { "/api": { target: serverUrl, changeOrigin: true } } } : {}) },
  test: { include: ["tests/**/*.test.ts"] },
});
