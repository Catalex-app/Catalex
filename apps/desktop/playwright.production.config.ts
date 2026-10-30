import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  testMatch: "production-startup.spec.ts",
  use: { baseURL: "http://127.0.0.1:4175" },
  webServer: {
    command:
      "npx --yes corepack pnpm exec vite preview --host 127.0.0.1 --port 4175 --strictPort",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: false,
  },
});
