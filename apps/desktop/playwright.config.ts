import { defineConfig } from "@playwright/test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "production-startup.spec.ts",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    headless: true,
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx --yes corepack pnpm dev --host 127.0.0.1 --port 4173",
    cwd: projectDir,
    url: "http://127.0.0.1:4173",
    timeout: 120_000,
    reuseExistingServer: true,
  },
});
