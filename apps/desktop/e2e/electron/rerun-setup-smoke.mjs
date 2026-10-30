import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-rerun-"));
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CATALEX_DEV_URL: "http://127.0.0.1:4175",
};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [process.cwd()], env });
try {
  const main = await app.firstWindow();
  await main
    .getByRole("button", { name: "Let’s get started", exact: true })
    .waitFor();
  await main
    .getByRole("button", { name: "Let’s get started", exact: true })
    .click();
  await main.getByRole("button", { name: "Skip for now", exact: true }).click();
  const settingsPromise = app.waitForEvent("window");
  await main.evaluate(() => window.catalex.invoke("open_settings_window"));
  const settings = await settingsPromise;
  await settings
    .getByRole("button", { name: "Rerun setup", exact: true })
    .waitFor();
  await settings.screenshot({ path: "test-results/rerun-setup-native.png" });
  const closed = settings.waitForEvent("close");
  await settings
    .getByRole("button", { name: "Rerun setup", exact: true })
    .click();
  await closed;
  await expect(
    main.getByRole("button", { name: "Let’s get started", exact: true }),
  ).toBeVisible();
  console.log("Settings closed and main window reopened onboarding.");
} finally {
  await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
