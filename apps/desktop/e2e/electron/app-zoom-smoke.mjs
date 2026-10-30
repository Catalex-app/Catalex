import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-zoom-"));
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/electron/app-zoom",
);
await fs.mkdir(artifacts, { recursive: true });
let app;
let vite;
async function ready(page) {
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  return page;
}
async function launch() {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [desktopRoot], env });
  return ready(await app.firstWindow());
}
async function settings(first) {
  const opened = app.waitForEvent("window");
  await first.evaluate(() => window.catalex.invoke("open_settings_window"));
  return ready(await opened);
}
async function nativeZoom(page, value) {
  const win = await app.browserWindow(page);
  await expect
    .poll(() => win.evaluate((w) => w.webContents.getZoomFactor()))
    .toBeCloseTo(value, 5);
}
async function quit() {
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await closed;
  app = undefined;
}
try {
  vite = await createServer({
    root: desktopRoot,
    configFile: path.join(desktopRoot, "vite.config.ts"),
    server: { port: 0 },
  });
  await vite.listen();
  let first = await launch();
  let prefs = await settings(first);
  const level = () => prefs.getByLabel("App zoom level");
  await expect(level()).toHaveValue("100");
  await prefs.getByRole("button", { name: "Zoom in app", exact: true }).click();
  await expect(level()).toHaveValue("110");
  await nativeZoom(prefs, 1.1);
  await nativeZoom(first, 1.1);
  await prefs.keyboard.press(
    process.platform === "darwin" ? "Meta+=" : "Control+=",
  );
  await expect(level()).toHaveValue("120");
  await nativeZoom(first, 1.2);
  await level().fill("137");
  await level().press("Enter");
  await expect(level()).toHaveValue("137");
  await nativeZoom(first, 1.37);
  await prefs.getByRole("button", { name: "Zoom in app", exact: true }).click();
  await expect(level()).toHaveValue("140");
  await nativeZoom(first, 1.4);
  await level().fill("137");
  await level().press("Enter");
  await expect(level()).toHaveValue("137");
  await prefs
    .getByRole("button", { name: "Zoom out app", exact: true })
    .click();
  await expect(level()).toHaveValue("130");
  await nativeZoom(first, 1.3);
  await level().fill("5");
  await level().press("Enter");
  await expect(level()).toHaveValue("50");
  await nativeZoom(prefs, 0.5);
  await level().fill("999");
  await level().press("Enter");
  await expect(level()).toHaveValue("300");
  await nativeZoom(first, 3);
  await level().fill("120");
  await level().press("Tab");
  await expect(level()).toHaveValue("120");
  await nativeZoom(prefs, 1.2);
  await level().fill("");
  await level().press("Enter");
  await expect(level()).toHaveValue("120");
  await level().fill("invalid");
  await level().press("Enter");
  await expect(level()).toHaveValue("120");
  await level().fill("180");
  await level().press("Escape");
  await expect(level()).toHaveValue("120");
  await level().press("Tab");
  const settingsWindow = await app.browserWindow(prefs);
  const capture = await settingsWindow.evaluate(async (win) =>
    (await win.webContents.capturePage()).toPNG().toString("base64"),
  );
  await fs.writeFile(
    path.join(artifacts, "appearance-120.png"),
    Buffer.from(capture, "base64"),
  );
  await quit();
  first = await launch();
  prefs = await settings(first);
  await expect(level()).toHaveValue("120");
  await nativeZoom(first, 1.2);
  await nativeZoom(prefs, 1.2);
  await prefs
    .getByRole("button", { name: "Zoom out app", exact: true })
    .click();
  await expect(level()).toHaveValue("110");
  await prefs
    .getByRole("button", { name: "Reset app zoom", exact: true })
    .click();
  await expect(level()).toHaveValue("100");
  await nativeZoom(first, 1);
  await expect(
    prefs.getByRole("button", { name: "Reset app zoom", exact: true }),
  ).toBeDisabled();
  for (const [value, name] of [
    [0.5, "Zoom out app"],
    [3, "Zoom in app"],
  ]) {
    await prefs.evaluate(async (value) => {
      const { persistAppZoom } = await import("/src/renderer/lib/app-zoom.ts");
      await persistAppZoom(value);
    }, value);
    await expect(
      prefs.getByRole("button", { name, exact: true }),
    ).toBeDisabled();
  }
  await prefs.evaluate(async () =>
    (await import("/src/renderer/lib/app-zoom.ts")).resetAppZoom(),
  );
  await prefs.getByPlaceholder("Search settings").fill("zoom");
  await expect(
    prefs.getByText("App Zoom", { exact: true }).first(),
  ).toBeVisible();
  assert.equal(
    await prefs.evaluate(() => localStorage.getItem("catalex-app-zoom")),
    "1",
  );
  console.log(
    "App zoom controls, shortcuts, window synchronization, limits, and restart persistence passed.",
  );
} finally {
  if (app) await app.close();
  if (vite) await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
