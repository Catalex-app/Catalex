import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

process.env.CATALEX_PERFORMANCE_BUILD = "1";
export default defineConfig({
  ...config,
  testMatch: [
    "comment-typing-performance.spec.ts",
    "comment-session-performance.spec.ts",
  ],
  webServer: {
    command:
      "npx --yes corepack pnpm exec vite build --config vite.performance.config.ts && npx --yes corepack pnpm exec vite preview --outDir dist/performance --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173/dev/typing-performance.html",
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
