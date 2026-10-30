import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-trash-"));
const name = `Trash test ${path.basename(profile)}`;
const project = path.join(profile, name);
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/electron/project-trash",
);
await fs.mkdir(project);
await fs.writeFile(path.join(project, "notes.md"), "Recoverable project\n");
await fs.mkdir(artifacts, { recursive: true });
let app;
let vite;
try {
  vite = await createServer({
    root: desktopRoot,
    configFile: path.join(desktopRoot, "vite.config.ts"),
    server: { port: 0 },
  });
  await vite.listen();
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [desktopRoot], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await (await app.browserWindow(page)).evaluate((win) => {
    win.unmaximize();
    win.setSize(1200, 800);
  });
  const add = () =>
    page.evaluate(async (project) => {
      const { useProjectStore } = await import(
        "/src/renderer/stores/project-store.ts"
      );
      useProjectStore.getState().addRecentProject(project);
    }, project);
  await add();
  // Inspect the responsive column split and cap at narrow and wide widths.
  for (const width of [900, 1200, 1800]) {
    await (await app.browserWindow(page)).evaluate(
      (win, width) => win.setSize(width, 800),
      width,
    );
    await page.screenshot({
      path: path.join(artifacts, `columns-${width}.png`),
      animations: "disabled",
    });
    console.log(
      "columns",
      width,
      await page
        .locator("thead th")
        .evaluateAll((cells) =>
          cells.map((cell) => Math.round(cell.getBoundingClientRect().width)),
        ),
    );
  }
  await (await app.browserWindow(page)).evaluate((win) =>
    win.setSize(1200, 800),
  );
  const row = page
    .locator("tr[data-project-path]")
    .filter({ hasText: project });
  await row
    .getByRole("button", { name: `Remove ${name}`, exact: true })
    .click();
  await expect(row).toHaveCount(0);
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    "Recoverable project\n",
  );
  await add();
  await row
    .getByRole("button", { name: `Move ${name} to Trash`, exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(project);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(row).toHaveCount(1);
  await row
    .getByRole("button", { name: `Move ${name} to Trash`, exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await page.screenshot({
    path: path.join(artifacts, "confirmation.png"),
    animations: "disabled",
  });
  // Simulate another window acquiring the project after the confirmation opened.
  const lease = await page.evaluate(
    async (project) =>
      (
        await window.catalex.invoke("desktop:project:acquire", {
          path: project,
        })
      ).result,
    project,
  );
  await dialog
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Close this project");
  await expect(row).toHaveCount(1);
  await page.evaluate(
    (token) => window.catalex.invoke("desktop:project:release", { token }),
    lease,
  );
  await dialog
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await assert.rejects(fs.stat(project), { code: "ENOENT" });
  if (process.platform === "darwin") {
    const trashed = path.join(os.homedir(), ".Trash", name);
    assert.equal(
      await fs.readFile(path.join(trashed, "notes.md"), "utf8"),
      "Recoverable project\n",
    );
    // Restore only this uniquely named test fixture for cleanup.
    await fs.rename(trashed, project);
  }
  assert.deepEqual(errors, []);
  console.log(
    "Remove preserves files; confirmation cancel, active-project failure, retry and real system Trash passed.",
  );
} finally {
  await app?.close();
  await vite?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
