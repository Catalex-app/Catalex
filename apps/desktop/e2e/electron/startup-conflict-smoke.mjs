import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-startup-conflict-"),
);
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
});
let app;
async function launch() {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env });

  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => console.error(error));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error(msg.text());
  });
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.evaluate(async () =>
    (
      await import("/src/renderer/stores/onboarding-store.ts")
    ).useOnboardingStore
      .getState()
      .finish(),
  );

  return page;
}
async function close() {
  const closed = app.waitForEvent("close", { timeout: 15000 });
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await closed.catch((error) => {
    app.process().kill("SIGKILL");
    throw error;
  });

  app = undefined;
}

try {
  await vite.listen();
  let page = await launch();
  const key = "catalex-project-chats:/startup-conflict-fixture";
  const disk = JSON.stringify({
    tabs: [{ id: "disk", draft: "saved disk draft" }],
  });
  const browser = JSON.stringify({
    tabs: [{ id: "browser", draft: "browser draft to preserve" }],
  });
  await page.evaluate(
    async ({ key, disk, browser }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      await invoke("desktop:workspace-state:write", {
        key,
        value: disk,
        revision: null,
      });
      localStorage.setItem(key, browser);
    },
    { key, disk, browser },
  );
  await close();
  page = await launch();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), key))
    .toBeNull();
  await expect(
    page.getByText("Conflicting browser recovery data was backed up.", {
      exact: false,
    }),
  ).toBeVisible();
  const conflictDir = path.join(
    profile,
    "workspace-state",
    "migration-conflicts",
  );
  const backups = await fs.readdir(conflictDir);
  assert.equal(backups.length, 1);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(conflictDir, backups[0]), "utf8")),
    { key, browserValue: browser, diskValue: disk },
  );
  assert.equal(
    await page.evaluate(async (key) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      return (await invoke("desktop:workspace-state:read", { key })).value;
    }, key),
    disk,
  );
  await close();
  page = await launch();
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), key),
    null,
  );
  assert.deepEqual(await fs.readdir(conflictDir), backups);
  console.log(
    "PASS: conflicting browser recovery no longer blocks startup; both exact copies preserved across restart",
  );
} finally {
  if (app) app.process().kill("SIGKILL");
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
