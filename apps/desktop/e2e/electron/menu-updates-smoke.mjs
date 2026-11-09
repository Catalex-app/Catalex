import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-menu-updates-"),
);
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/electron/menu-updates",
);
await fs.mkdir(artifacts, { recursive: true });
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
const app = await electron.launch({ args: [desktopRoot], env });
const errors = [];
const watch = (page) =>
  page.on("pageerror", (error) => errors.push(error.message));
app.on("window", watch);
const page = await app.firstWindow();
watch(page);
async function menuState() {
  return app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu().getMenuItemById("check-for-updates");
    return {
      label: item.label,
      enabled: item.enabled,
      accelerator: item.accelerator,
    };
  });
}
async function clickCheck() {
  await expect.poll(async () => (await menuState()).enabled).toBe(true);
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu().getMenuItemById("check-for-updates").click(),
  );
}
async function finishCheck(mode) {
  await app.evaluate((_electron, mode) => {
    globalThis.menuUpdates.mode = mode;
    globalThis.menuUpdates.release();
  }, mode);
  await expect
    .poll(async () => (await menuState()).label)
    .toBe("Check for Updates…");
  assert.equal((await menuState()).enabled, true);
}
try {
  await app.evaluate(({ session, net }) => {
    globalThis.menuUpdates = {
      requests: 0,
      mode: "available",
      release: null,
    };
    session.defaultSession.protocol.handle("https", async (request) => {
      if (new URL(request.url).hostname !== "api.github.com")
        return net.fetch(request, { bypassCustomProtocolHandlers: true });
      globalThis.menuUpdates.requests++;
      await new Promise((resolve) => {
        globalThis.menuUpdates.release = resolve;
      });
      if (globalThis.menuUpdates.mode === "error")
        return new Response("Unavailable", { status: 503 });
      return new Response(
        JSON.stringify(
          globalThis.menuUpdates.mode === "current"
            ? []
            : [
                {
                  tag_name: "v99.0.0",
                  draft: false,
                  prerelease: false,
                  body: "Menu update test release.",
                  assets: [
                    {
                      name: "Catalex-99.0.0-arm64.dmg",
                      state: "uploaded",
                      size: 123,
                    },
                  ],
                },
              ],
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    });
  });
  await page.waitForFunction(() => !!window.catalex);
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  // A startup check may already be in flight when the network fixture attaches.
  await expect
    .poll(
      async () => {
        await app.evaluate(() => globalThis.menuUpdates.release?.());
        return (
          await page.evaluate(() =>
            window.catalex.invoke("desktop:updater:state"),
          )
        ).result.checking;
      },
      { timeout: 20_000 },
    )
    .toBe(false);
  const before = await app.evaluate(() => globalThis.menuUpdates.requests);
  const opened = app.waitForEvent("window");
  await clickCheck();
  const settings = await opened;
  await expect(
    settings.getByRole("button", { name: "Check for updates", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await menuState()).label)
    .toBe("Checking for Updates…");
  assert.equal((await menuState()).enabled, false);
  assert.equal((await menuState()).accelerator, null);
  await expect(
    settings.getByRole("button", { name: "Check for updates", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() => app.evaluate(() => globalThis.menuUpdates.requests))
    .toBe(before + 1);
  await settings.screenshot({ path: path.join(artifacts, "checking.png") });
  await finishCheck("available");
  await expect(settings.getByRole("status")).toHaveText("99.0.0 available");
  await settings.screenshot({ path: path.join(artifacts, "available.png") });

  await settings
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await settings.getByPlaceholder("Search settings").fill("theme");
  await clickCheck();
  await expect(settings.getByPlaceholder("Search settings")).toHaveValue("");
  await expect(
    settings.getByRole("button", { name: "Check for updates", exact: true }),
  ).toBeDisabled();
  assert.equal(app.windows().length, 2, "Reuse the existing Settings window");
  // Rebuilding the menu for a different window must preserve the app-wide busy state.
  const mainId = await (await app.browserWindow(page)).evaluate(
    (win) => win.id,
  );
  await app.evaluate(
    ({ app, BrowserWindow }, id) =>
      app.emit("browser-window-focus", {}, BrowserWindow.fromId(id)),
    mainId,
  );
  assert.equal((await menuState()).enabled, false);
  await expect
    .poll(() => app.evaluate(() => globalThis.menuUpdates.requests))
    .toBe(before + 2);
  await finishCheck("current");
  await expect(settings.getByRole("status")).toHaveText(
    "Catalex is up to date.",
  );

  await clickCheck();
  await expect
    .poll(() => app.evaluate(() => globalThis.menuUpdates.requests))
    .toBe(before + 3);
  await finishCheck("error");
  await expect(settings.getByRole("status")).toContainText(
    "Could not check GitHub for updates",
  );
  await settings.screenshot({ path: path.join(artifacts, "error.png") });
  await clickCheck();
  await expect
    .poll(() => app.evaluate(() => globalThis.menuUpdates.requests))
    .toBe(before + 4);
  await finishCheck("available");
  await expect(settings.getByRole("status")).toHaveText("99.0.0 available");
  assert.deepEqual(errors, []);
  console.log(
    "Native update menu: new/existing About navigation, one shared check, busy state across window changes, available/current/error results, and retry passed.",
  );
} catch (error) {
  await app
    .windows()
    .at(-1)
    ?.screenshot({ path: path.join(artifacts, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
