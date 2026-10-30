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
const fileName = `file-${path.basename(profile)}.tex`;
const folderName = `folder-${path.basename(profile)}`;
await fs.writeFile(path.join(project, fileName), "Sample text");
await fs.mkdir(path.join(project, folderName));
await fs.writeFile(path.join(project, folderName, "child.tex"), "Nested text");
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
  await page.evaluate(async (project) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(project);
  }, project);
  const fileRow = page.getByText(fileName, { exact: true }).first();
  await fileRow.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Move to Trash" }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(artifacts, "sidebar-menu.png"),
    animations: "disabled",
  });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(fileRow).toHaveCount(0);
  await assert.rejects(fs.stat(path.join(project, fileName)), {
    code: "ENOENT",
  });
  await page
    .getByText(folderName, { exact: true })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(page.getByText(folderName, { exact: true })).toHaveCount(0);
  await assert.rejects(fs.stat(path.join(project, folderName)), {
    code: "ENOENT",
  });
  if (process.platform === "darwin") {
    for (const name of [fileName, folderName]) {
      const trashed = path.join(os.homedir(), ".Trash", name);
      await fs.stat(trashed);
      await fs.rename(trashed, path.join(project, name));
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    "Sidebar file and folder menus move disposable items to recoverable system Trash.",
  );
} finally {
  await app?.close();
  await vite?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
