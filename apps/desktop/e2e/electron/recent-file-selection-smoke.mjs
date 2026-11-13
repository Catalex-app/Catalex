import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-recent-files-"),
);
const project = path.join(profile, "Project");
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/electron/recent-files",
);
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
for (const name of ["A", "B", "C", "D", "E", "F", "G", "H"])
  await fs.writeFile(path.join(project, `${name}.md`), `# ${name}\n`);
const vite = await createServer({
  root: desktopRoot,
  configFile: path.join(desktopRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0 },
});
await vite.listen();
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const errors = [];

async function ready(page) {
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.evaluate(async () =>
    (
      await import("/src/renderer/stores/onboarding-store.ts")
    ).useOnboardingStore
      .getState()
      .finish(),
  );
  return page;
}
async function launch() {
  app = await electron.launch({ args: [desktopRoot], env });
  return ready(await app.firstWindow());
}
async function openProject(page) {
  await page.evaluate(async (root) => {
    (await import("/src/renderer/stores/settings-store.ts")).useSettingsStore
      .getState()
      .setWorkspacePreferences(root, { mode: "duet", chatLayout: "workspace" });
    await (
      await import("/src/renderer/stores/document-store.ts")
    ).useDocumentStore
      .getState()
      .openProject(root);
  }, project);
  await expect(
    page.getByRole("combobox", { name: "Choose file" }),
  ).toBeVisible();
}
async function select(page, name) {
  await page.getByRole("combobox", { name: "Choose file" }).click();
  await page.getByRole("option", { name: `${name}.md`, exact: true }).click();
}
async function history(page) {
  return page.evaluate(
    async (root) =>
      (
        await import("/src/renderer/stores/project-store.ts")
      ).useProjectStore.getState().recentFilesByProject[root],
    project,
  );
}
async function checkMenu(page) {
  await page.getByRole("combobox", { name: "Choose file" }).click();
  await expect(
    page.getByRole("group", { name: "Recent files" }).getByRole("option"),
  ).toHaveText(["B.md", "D.md", "A.md", "C.md", "F.md"]);
  await expect(
    page.getByRole("group", { name: "Other files" }).getByRole("option"),
  ).toHaveText(["E.md", "G.md", "H.md"]);
  await page.screenshot({ path: path.join(artifacts, "dropdown.png") });
  await page.keyboard.press("Escape");
}
async function quit() {
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app }) => setImmediate(() => app.quit()));
  await closed;
  app = undefined;
}

try {
  const first = await launch();
  await openProject(first);
  const opened = app.waitForEvent("window");
  await first.evaluate(() => window.catalex.invoke("create_new_window"));
  const second = await ready(await opened);
  for (const name of ["E", "B", "D", "A", "C", "B", "F"])
    await select(first, name);
  await checkMenu(first);
  const expected = await history(first);
  await expect.poll(() => history(second)).toEqual(expected);
  // Reopen in the second native window through real project ownership changes.
  assert.equal(
    await first.evaluate(async () =>
      (await import("/src/renderer/stores/document-store.ts")).useDocumentStore
        .getState()
        .closeProject(),
    ),
    true,
  );
  await openProject(second);
  await checkMenu(second);
  await quit();

  const restarted = await launch();
  await expect.poll(() => history(restarted)).toEqual(expected);
  await openProject(restarted);
  await checkMenu(restarted);
  // Recency, as well as row order, must survive a complete application restart.
  await select(restarted, "G");
  await restarted.getByRole("combobox", { name: "Choose file" }).click();
  await expect(
    restarted.getByRole("group", { name: "Recent files" }).getByRole("option"),
  ).toHaveText(["B.md", "A.md", "C.md", "F.md", "G.md"]);
  await restarted.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  await quit();
  console.log(
    "Recent files: native selections, cross-window sync, project reopening, restart persistence, and eviction passed.",
  );
} finally {
  if (app) await app.close();
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
