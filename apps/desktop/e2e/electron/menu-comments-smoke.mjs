import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-menu-"));
const project = path.join(profile, "Project");
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/electron/menu-comments",
);
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(path.join(project, "notes.md"), "Hello menu\n");
await fs.writeFile(path.join(project, "main.tex"), "Hello LaTeX\n");
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
async function focus(page) {
  await app.evaluate(({ app }) => app.focus({ steal: true }));
  const win = await app.browserWindow(page);
  await win.evaluate((window) => {
    window.show();
    window.focus();
  });
  // Background automation on macOS may never acquire native focus. Exercise
  // the same Electron focus event explicitly, without faking menu state or IPC.
  if (!(await win.evaluate((window) => window.isFocused()))) {
    const id = await win.evaluate((window) => window.id);
    await app.evaluate(({ app, BrowserWindow }, id) => {
      app.emit("browser-window-focus", {}, BrowserWindow.fromId(id));
    }, id);
  }
}

async function menu(id) {
  return app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu().getMenuItemById(id);
    return item
      ? {
          enabled: item.enabled,
          accelerator: item.accelerator,
          checked: item.checked,
        }
      : null;
  }, id);
}
async function click(id) {
  await expect.poll(async () => (await menu(id))?.enabled).toBe(true);
  await app.evaluate(({ Menu, BrowserWindow }, id) => {
    const item = Menu.getApplicationMenu().getMenuItemById(id);
    item.click(undefined, BrowserWindow.getFocusedWindow());
  }, id);
}
async function selectHello(page) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
}
async function openProject(page) {
  await focus(page);
  await page.evaluate(async (root) => {
    (await import("/src/renderer/stores/project-store.ts")).useProjectStore
      .getState()
      .addRecentProject(root);
  }, project);
  await expect
    .poll(() =>
      app.evaluate(
        ({ Menu }) =>
          Menu.getApplicationMenu()
            .items.find((item) => item.label === "File")
            .submenu.items.find((item) => item.label === "Open Recent Projects")
            ?.enabled,
      ),
    )
    .toBe(true);
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const recent = Menu.getApplicationMenu()
      .items.find((item) => item.label === "File")
      .submenu.items.find((item) => item.label === "Open Recent Projects");
    recent.submenu.items[0].click(undefined, BrowserWindow.getFocusedWindow());
  });
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await new Promise((resolve) => {
      if (useDocumentStore.getState().projectRoot) return resolve();
      const stop = useDocumentStore.subscribe((state) => {
        if (state.projectRoot) {
          stop();
          resolve();
        }
      });
    });
    useDocumentStore.getState().setActiveFile("notes.md");
  });
  await expect(page.locator(".cm-content")).toContainText("Hello");
}
try {
  const page = await launch();
  await openProject(page);
  await click("manage-comments");
  const manager = page.getByRole("dialog", {
    name: "Manage comments",
    exact: true,
  });
  await expect(manager).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "project-manager.png") });
  await manager.getByRole("button", { name: "Close", exact: true }).click();

  await expect
    .poll(async () => (await menu("add-comment"))?.enabled)
    .toBe(false);
  const opened = app.waitForEvent("window");
  await page.evaluate(async () =>
    (await import("/src/renderer/lib/panel-windows.ts")).openPanelWindow(
      "preview",
      "duet",
    ),
  );
  const panel = await ready(await opened);
  await focus(panel);
  await expect.poll(async () => await menu("manage-comments")).toBe(null);
  const closed = panel.waitForEvent("close");
  await (await app.browserWindow(panel)).evaluate((win) => win.close());
  await closed;
  await focus(page);
  await selectHello(page);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await click("add-comment");
  const editor = page.getByRole("textbox", {
    name: "Comment text",
    exact: true,
  });
  await expect(editor).toBeVisible();
  await editor.fill("Native editor comment");
  await editor.press("Enter");
  await page
    .getByRole("button", { name: /^Show comments:/ })
    .filter({ visible: true })
    .first()
    .click();
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "editor-comment.png"),
  });
  await click("toggle-comments");
  await expect
    .poll(async () => (await menu("toggle-comments"))?.checked)
    .toBe(false);
  await expect
    .poll(async () => (await menu("toggle-preview-comments"))?.enabled)
    .toBe(false);
  await expect
    .poll(async () => (await menu("manage-comments"))?.enabled)
    .toBe(true);
  await click("toggle-comments");
  await page
    .getByRole("button", { name: "Hide comments", exact: true })
    .filter({ visible: true })
    .click();

  // The iframe selection must win over the previous CodeMirror selection.
  await selectHello(page);
  const preview = page.frameLocator('iframe[title="notes.md preview"]');
  await preview.locator("#write").click();
  await preview.locator("#write").evaluate((element) => {
    const walker = element.ownerDocument.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
    );
    let text;
    while ((text = walker.nextNode()) && !text.textContent.includes("menu")) {}
    const offset = text.textContent.indexOf("menu");
    const range = element.ownerDocument.createRange();
    range.setStart(text, offset);
    range.setEnd(text, offset + 4);
    const selection = element.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect
    .poll(async () => (await menu("inline:bold"))?.enabled)
    .toBe(false);
  await expect(preview.locator("#write")).toContainText("menu");
  await click("add-comment");
  await expect(
    page.getByRole("textbox", { name: "Comment text", exact: true }).last(),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .last()
    .fill("Native preview comment");
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .last()
    .press("Enter");
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "markdown-comment.png"),
  });
  await expect
    .poll(() =>
      page.evaluate(async (projectRoot) => {
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        const { flushProjectCommentWrites } = await import(
          "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
        );
        await flushProjectCommentWrites(projectRoot);
        const snapshot = await invoke("read_project_comments_anchored", {
          projectRoot,
        });
        return (snapshot.files["notes.md"] ?? []).map(({ text, from, to }) => ({
          text,
          from,
          to,
        }));
      }, project),
    )
    .toEqual([
      { text: "Native editor comment", from: 0, to: 5 },
      { text: "Native preview comment", from: 6, to: 10 },
    ]);
  await click("toggle-preview-comments");
  await expect
    .poll(async () => (await menu("toggle-preview-comments"))?.checked)
    .toBe(false);
  await expect
    .poll(async () => (await menu("add-comment"))?.enabled)
    .toBe(false);
  await click("toggle-preview-comments");

  const pdfPath = path.join(project, "preview.pdf");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, pdfPath);
  await click("export-pdf");
  await expect
    .poll(() =>
      fs
        .stat(pdfPath)
        .then((s) => s.size)
        .catch(() => 0),
    )
    .toBeGreaterThan(1000);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (
          await import("/src/renderer/stores/document-store.ts")
        ).useDocumentStore
          .getState()
          .files.some((f) => f.id === "preview.pdf"),
      ),
    )
    .toBe(true);
  await page.evaluate(async () =>
    (await import("/src/renderer/stores/document-store.ts")).useDocumentStore
      .getState()
      .setActiveFile("preview.pdf"),
  );
  await expect
    .poll(async () => (await menu("manage-comments"))?.enabled)
    .toBe(true);
  const pdfText = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Hello" })
    .first();
  await expect(pdfText).toBeVisible();
  await pdfText.click();
  await pdfText.evaluate((element) => {
    const node = element.firstChild;
    window.getSelection().setBaseAndExtent(node, 0, node, 5);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await click("add-comment");
  const pdfEditor = page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .filter({ visible: true });
  await expect(pdfEditor).toBeVisible();
  await pdfEditor.fill("Native PDF comment");
  await pdfEditor.press("Enter");
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "pdf-comment.png"),
  });
  await expect
    .poll(() =>
      page.evaluate(async (projectRoot) => {
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        const { flushProjectCommentWrites } = await import(
          "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
        );
        await flushProjectCommentWrites(projectRoot);
        const snapshot = await invoke("read_project_comments_anchored", {
          projectRoot,
        });
        const comment = snapshot.files["preview.pdf"]?.[0];
        return { text: comment?.text, selected: comment?.pdf?.text };
      }, project),
    )
    .toEqual({ text: "Native PDF comment", selected: "Hello" });
  await click("toggle-preview-comments");
  await app.close();
  app = undefined;
  const restarted = await launch();
  await focus(restarted);
  await openProject(restarted);
  await expect
    .poll(async () => (await menu("toggle-preview-comments"))?.checked)
    .toBe(false);
  await click("toggle-preview-comments");
  const summary = restarted
    .getByRole("button", { name: /^Show comments:/ })
    .filter({ visible: true });
  if (await summary.count()) await summary.first().click();
  await expect(
    restarted
      .getByRole("status", { name: "Comment 1 of 2", exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "Native comment menus: existing project manager, editor and Markdown preview creation, visibility toggles, standalone PDF comments, preview-only management, and restart persistence passed.",
  );
} catch (error) {
  await app
    ?.windows()[0]
    ?.screenshot({ path: path.join(artifacts, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await app?.close();
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
