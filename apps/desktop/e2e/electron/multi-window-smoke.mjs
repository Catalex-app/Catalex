import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-windows-"));
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/electron/multi-window",
);
const project = path.join(profile, "Shared project");
const other = path.join(profile, "Other project");
const alias = path.join(profile, "Project alias");
const broken = path.join(profile, "Failed project");
for (const folder of [project, other, broken]) {
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "notes.md"), "# Saved notes\n");
}
await fs.symlink(
  project,
  alias,
  process.platform === "win32" ? "junction" : "dir",
);
await fs.mkdir(artifacts, { recursive: true });
let app;
let vite;
const errors = [];

async function ready(page) {
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
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
async function newWindow(page) {
  const opened = app.waitForEvent("window");
  await page.evaluate(() => window.catalex.invoke("create_new_window"));
  return ready(await opened);
}
async function openProject(page, root) {
  return page.evaluate(async (root) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    try {
      await useDocumentStore.getState().openProject(root);
      return null;
    } catch (error) {
      return String(error);
    }
  }, root);
}
async function closeProject(page) {
  assert.equal(
    await page.evaluate(async () => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      return useDocumentStore.getState().closeProject();
    }),
    true,
  );
}
function row(page, root) {
  return page.locator("tr[data-project-path]").filter({ hasText: root });
}
async function font(page) {
  return page.evaluate(
    async () =>
      (
        await import("/src/renderer/stores/settings-store.ts")
      ).useSettingsStore.getState().editorFontSize,
  );
}
async function setFont(page, value) {
  await page.evaluate(
    async (value) =>
      (await import("/src/renderer/stores/settings-store.ts")).useSettingsStore
        .getState()
        .setEditorFontSize(value),
    value,
  );
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
    server: { port: 0, strictPort: false },
  });
  await vite.listen();
  let first = await launch();
  await first.evaluate(
    async (roots) => {
      const { useProjectStore } = await import(
        "/src/renderer/stores/project-store.ts"
      );
      for (const root of roots)
        useProjectStore.getState().addRecentProject(root);
    },
    [project, other],
  );
  assert.equal(await openProject(first, project), null);
  const second = await newWindow(first);
  await (await app.browserWindow(second)).evaluate((win) => {
    win.unmaximize();
    win.setSize(1200, 800);
  });
  await expect(row(second, project).locator("td").nth(1)).toHaveText(
    "Currently open",
  );
  await expect(
    row(second, project).getByRole("button", { name: /^Shared project/ }),
  ).toBeEnabled();
  await expect(
    row(second, project).getByRole("button", { name: /Remove/ }),
  ).toBeDisabled();
  await expect(
    row(second, other).getByRole("button", { name: /Remove/ }),
  ).toBeEnabled();
  await second.screenshot({ path: path.join(artifacts, "occupied.png") });
  const ownerWindow = await app.browserWindow(first);
  await ownerWindow.evaluate((win) => win.minimize());
  await row(second, project)
    .getByRole("button", { name: /^Shared project/ })
    .click();
  await expect
    .poll(() => ownerWindow.evaluate((win) => win.isMinimized()))
    .toBe(false);
  await expect
    .poll(() => ownerWindow.evaluate((win) => win.isFocused()))
    .toBe(true);
  assert.match(await openProject(second, alias), /open in another window/);
  await setFont(first, 19);
  await expect.poll(() => font(second)).toBe(19);
  await setFont(second, 21);
  await expect.poll(() => font(first)).toBe(21);
  // A failed open after reservation must free its ownership.
  await second.evaluate(
    (root) =>
      localStorage.setItem(`catalex-project-chats:${root}`, "invalid json"),
    broken,
  );
  assert.ok(await openProject(second, broken));
  const owners = await second.evaluate(
    async (root) =>
      (
        await window.catalex.invoke("desktop:project:owners", {
          paths: [root],
        })
      ).result,
    broken,
  );
  assert.equal(owners[broken], null);
  // Another project can run independently.
  assert.equal(await openProject(second, other), null);
  assert.match(await openProject(second, project), /open in another window/);
  assert.equal(
    await second.evaluate(
      async () =>
        (
          await import("/src/renderer/stores/document-store.ts")
        ).useDocumentStore.getState().projectRoot,
    ),
    other,
  );
  await closeProject(second);

  // Hold the real close/save boundary and verify ownership remains until it finishes.
  await first.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const original = useDocumentStore.getState().saveAllFiles;
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    window.finishTestSave = release;
    useDocumentStore.setState({
      saveAllFiles: async (...args) => {
        await held;
        return original(...args);
      },
    });
    window.testClose = useDocumentStore
      .getState()
      .closeProject()
      .finally(() => useDocumentStore.setState({ saveAllFiles: original }));
  });
  assert.match(await openProject(second, project), /open in another window/);
  await expect(row(second, project).locator("td").nth(1)).toHaveText(
    "Currently open",
  );
  await first.evaluate(async () => {
    window.finishTestSave();
    await window.testClose;
  });
  await expect(
    row(second, project).getByRole("button", { name: /Remove/ }),
  ).toBeEnabled();

  const results = await Promise.all([
    openProject(first, project),
    openProject(second, alias),
  ]);
  assert.equal(results.filter((result) => result === null).length, 1);
  assert.match(
    results.find((result) => result !== null),
    /open in another window/,
  );
  const winner = results[0] === null ? first : second;
  const loser = results[0] === null ? second : first;
  // Window close releases the project only after its normal shutdown handling.
  const closed = winner.waitForEvent("close");
  await (await app.browserWindow(winner)).evaluate((win) => win.close());
  await closed;
  await expect(
    row(loser, project).getByRole("button", { name: /Remove/ }),
  ).toBeEnabled();
  assert.equal(await openProject(loser, project), null);
  const observer = await newWindow(loser);
  await expect(row(observer, project).locator("td").nth(1)).toHaveText(
    "Currently open",
  );
  await (await app.browserWindow(loser)).evaluate((win) =>
    win.webContents.forcefullyCrashRenderer(),
  );
  await expect(
    row(observer, project).getByRole("button", { name: /Remove/ }),
  ).toBeEnabled();
  assert.equal(await openProject(observer, project), null);
  await observer.reload();
  await ready(observer);
  await expect(
    row(observer, project).getByRole("button", { name: /Remove/ }),
  ).toBeEnabled();
  assert.equal(await openProject(observer, project), null);
  await quit();
  first = await launch();
  assert.equal(await font(first), 21);
  await expect(
    row(first, project).getByRole("button", { name: /Remove/ }),
  ).toBeEnabled();
  assert.equal(await openProject(first, project), null);
  assert.deepEqual(errors, []);
  console.log(
    "Settings synchronized both ways and persisted; occupied rows, focus, aliases, racing opens, failed opens, save-before-release, close and restart passed.",
  );
} catch (error) {
  await app
    ?.windows()[0]
    ?.screenshot({ path: path.join(artifacts, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await app?.close();
  await vite?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
