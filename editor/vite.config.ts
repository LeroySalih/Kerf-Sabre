import { defineConfig } from "vitest/config";

export default defineConfig({
  // Machine profiles live in ../shared and are imported at build time.
  server: { fs: { allow: [".."] } },
  test: { include: ["tests/**/*.test.ts"] },
});
