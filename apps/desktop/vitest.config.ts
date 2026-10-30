import { defineConfig } from "vitest/config";
import path from "node:path";
import { buildDocumentCore } from "../../scripts/build-document-core.mjs";

buildDocumentCore();

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/renderer"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/renderer/__tests__/mocks/desktop.ts"],
    include: ["src/renderer/**/*.{test,spec}.{ts,tsx}"],
  },
});
