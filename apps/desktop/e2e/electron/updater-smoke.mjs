import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

// Uses the real preload/host IPC and Electron network stack. Only GitHub release
// responses and opening the external browser are replaced with test fixtures.
const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-updater-"));
const artifacts = path.resolve(desktopRoot, "../../output/playwright/updater");
await fs.mkdir(artifacts, { recursive: true });
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CATALEX_SMOKE_EXECUTABLE) delete env.CATALEX_DEV_URL;
const launch = process.env.CATALEX_SMOKE_EXECUTABLE
  ? { executablePath: process.env.CATALEX_SMOKE_EXECUTABLE, args: [] }
  : { args: [desktopRoot] };
let app = await electron.launch({
  ...launch,
  env,
  timeout: 30_000,
});
async function installReleaseFixtures(app) {
  await app.evaluate(({ session, net, shell, app }) => {
    globalThis.updaterSmoke = { opened: [], requests: [], relaunches: 0 };
    shell.openExternal = async (url) => {
      globalThis.updaterSmoke.opened.push(url);
    };
    app.relaunch = () => {
      globalThis.updaterSmoke.relaunches++;
    };
    session.defaultSession.protocol.handle("https", (request) => {
      if (new URL(request.url).host !== "api.github.com") {
        return net.fetch(request, { bypassCustomProtocolHandlers: true });
      }
      globalThis.updaterSmoke.requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
      });
      assertEndpoint(request.url);
      const release = (version, draft = false) => ({
        tag_name: `v${version}`,
        draft,
        prerelease: version.includes("-"),
        assets: [
          {
            name: `Catalex-${version}-arm64.dmg`,
            state: "uploaded",
            size: 123,
          },
        ],
      });
      return new Response(
        JSON.stringify(
          globalThis.updaterSmoke.noUpdate
            ? []
            : [
                release("0.1.1-beta"),
                release("0.1.10-beta"),
                release("0.1.2-beta"),
                release("9.0.0-beta", true),
                release("9.0.0-alpha"),
              ],
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    function assertEndpoint(url) {
      if (
        url !==
        "https://api.github.com/repos/Catalex-app/Catalex/releases?per_page=100"
      )
        throw new Error(`Unexpected update URL: ${url}`);
    }
  });
}

try {
  await installReleaseFixtures(app);
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.catalex);
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.catalex.invoke("desktop:updater:check"),
          )
        ).result?.update?.version,
      { timeout: 30_000 },
    )
    .toBe("0.1.10-beta");
  const reply = await page.evaluate(() =>
    window.catalex.invoke("desktop:updater:state"),
  );
  assert.deepEqual(reply.result.update, {
    mode: "manual",
    version: "0.1.10-beta",
    body: undefined,
    releaseUrl:
      "https://github.com/Catalex-app/Catalex/releases/tag/v0.1.10-beta",
  });
  const afterInitialCheck = await app.evaluate(
    () => globalThis.updaterSmoke.requests.length,
  );
  await page.evaluate(() =>
    localStorage.setItem(
      "catalex-onboarding",
      JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
    ),
  );
  await page.reload();
  const update = page.getByRole("button", {
    name: "Update available: Catalex 0.1.10-beta",
  });
  await expect(update).toBeVisible();
  await update.click();
  await expect.poll(() => app.windows().length).toBe(2);
  const settings = app.windows().find((window) => window !== page);
  await expect(settings.getByRole("status")).toContainText(
    "0.1.10-beta available",
  );
  await settings
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await settings.getByPlaceholder("Search settings").fill("theme");
  await update.click();
  await expect.poll(() => app.windows().length).toBe(2);
  await expect(settings.getByPlaceholder("Search settings")).toHaveValue("");
  await expect(settings.getByRole("status")).toContainText(
    "0.1.10-beta available",
  );
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit("resume");
  });
  assert.equal(
    await app.evaluate(() => globalThis.updaterSmoke.requests.length),
    afterInitialCheck,
    "Opening/reloading views must only read the app-wide result",
  );
  await app.evaluate(() => {
    globalThis.updaterSmoke.noUpdate = true;
  });
  await settings
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await expect(settings.getByRole("status")).toHaveText(
    "Catalex is up to date.",
  );
  await expect(update).toHaveCount(0);
  await app.evaluate(() => {
    globalThis.updaterSmoke.noUpdate = false;
  });
  await settings
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await expect(settings.getByRole("status")).toHaveText(
    "0.1.10-beta available",
  );
  await expect(update).toBeVisible();
  await settings.screenshot({
    path: path.join(artifacts, "electron-about.png"),
  });
  await settings
    .getByRole("button", { name: "Install update", exact: true })
    .click();
  const state = await app.evaluate(() => globalThis.updaterSmoke);
  assert.deepEqual(state.opened, [
    "https://github.com/Catalex-app/Catalex/releases/tag/v0.1.10-beta",
  ]);
  assert.equal(state.relaunches, 0);
  assert.ok(state.requests.length >= 1);
  assert.ok(state.requests.every((request) => request.authorization === null));
  assert.equal(app.process().exitCode, null);
  await settings
    .getByRole("button", { name: "Skip this version", exact: true })
    .click();
  await expect(settings.getByRole("status")).toHaveText("Skipped 0.1.10-beta");
  await expect(update).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("catalex-settings") ?? "{}").state
            ?.skippedUpdateVersions,
      ),
    )
    .toEqual(["0.1.10-beta"]);
  await app.close();
  app = await electron.launch({ ...launch, env, timeout: 30_000 });
  await installReleaseFixtures(app);
  const restarted = await app.firstWindow();
  await restarted.waitForFunction(() => !!window.catalex);
  await expect
    .poll(
      async () =>
        (
          await restarted.evaluate(() =>
            window.catalex.invoke("desktop:updater:check", { force: true }),
          )
        ).result?.update?.version,
    )
    .toBe("0.1.10-beta");
  await restarted.reload();
  await expect(restarted.locator(".sidebar-utility-controls")).toBeVisible();
  await expect(
    restarted.getByRole("button", { name: /Update available:/ }),
  ).toHaveCount(0);
  await restarted.evaluate(() =>
    window.catalex.invoke("open_settings_window", { section: "about" }),
  );
  await expect.poll(() => app.windows().length).toBe(2);
  const afterRestart = app.windows().find((window) => window !== restarted);
  await expect(afterRestart.getByRole("status")).toHaveText(
    "Skipped 0.1.10-beta",
  );
  await afterRestart
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await expect(afterRestart.getByRole("status")).toHaveText(
    "Skipped 0.1.10-beta",
  );
  await expect(
    afterRestart.getByRole("button", { name: "Install update", exact: true }),
  ).toHaveCount(0);
  await afterRestart
    .getByRole("button", { name: "View release", exact: true })
    .click();
  assert.deepEqual(await app.evaluate(() => globalThis.updaterSmoke.opened), [
    "https://github.com/Catalex-app/Catalex/releases/tag/v0.1.10-beta",
  ]);
  await expect(afterRestart.getByRole("status")).toHaveText(
    "Skipped 0.1.10-beta",
  );
  assert.deepEqual(
    await afterRestart.evaluate(
      () =>
        JSON.parse(localStorage.getItem("catalex-settings")).state
          .skippedUpdateVersions,
    ),
    ["0.1.10-beta"],
  );
  console.log(
    "App-wide snapshot reads, cross-window scheduled-state broadcasts, manual release opening, native window navigation, skip persistence through restart, and refresh retaining the skip passed.",
  );
  console.log(
    "Electron update IPC, public API request, highest eligible version, sidebar navigation to new/existing About windows, manual browser action, and no restart passed.",
  );
  console.log(
    `Settings screenshot: ${path.join(artifacts, "electron-about.png")}`,
  );
} finally {
  if (app.process().exitCode === null) await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
