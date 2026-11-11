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
  "../../output/playwright/electron/application-menu",
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
      ? { enabled: item.enabled, accelerator: item.accelerator }
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
  let page = await launch();
  await openProject(page);
  await selectHello(page);
  await click("inline:bold");
  await expect(page.locator(".cm-content")).toContainText("**Hello** menu");
  await click("save-file");
  await expect
    .poll(() => fs.readFile(path.join(project, "notes.md"), "utf8"))
    .toContain("**Hello** menu");
  await click("find");
  await expect(
    page.getByRole("textbox", { name: "Search", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await menu("inline:bold"))?.enabled)
    .toBe(false);
  await click("replace");
  await expect(
    page.getByPlaceholder("Replace...", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const editorSearch = page.getByTestId("editor-search-panel");
  await expect(editorSearch).toBeVisible();
  await editorSearch
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page.locator(".cm-content")).toBeFocused();
  await click("new-file");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "new-file.png") });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(await menu("open-project"), null);
  assert.equal(await menu("open-file"), null);
  await page.evaluate(async () =>
    (await import("/src/renderer/stores/document-store.ts")).useDocumentStore
      .getState()
      .setActiveFile("main.tex"),
  );
  await expect(page.locator(".cm-content")).toContainText("Hello LaTeX");
  await selectHello(page);
  await click("inline:bold");
  await expect(page.locator(".cm-content")).toContainText(
    "\\textbf{Hello} LaTeX",
  );
  assert.equal(await menu("block:heading-1"), null);
  assert.ok(await menu("inline:inline-math"));
  await page.evaluate(async () =>
    (await import("/src/renderer/stores/document-store.ts")).useDocumentStore
      .getState()
      .setActiveFile("notes.md"),
  );
  await expect(page.locator(".cm-content")).toContainText("**Hello** menu");
  // Moving into the Markdown iframe must release editor formatting and keep local Find.
  await selectHello(page);
  const markdownFrame = page.frameLocator('iframe[title="notes.md preview"]');
  await markdownFrame.locator("#write").click();
  await expect
    .poll(async () => (await menu("inline:bold"))?.enabled)
    .toBe(false);
  await page.keyboard.press("Meta+f");
  const markdownSearch = page
    .getByTestId("markdown-preview")
    .getByTestId("preview-search-panel");
  await expect(markdownSearch).toBeVisible();
  await markdownSearch
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const pdfPath = path.join(artifacts, "notes.pdf");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, pdfPath);
  await click("export-pdf");
  await expect
    .poll(() =>
      fs
        .stat(pdfPath)
        .then((stat) => stat.size)
        .catch(() => 0),
    )
    .toBeGreaterThan(1000);
  await page.screenshot({ path: path.join(artifacts, "formatted.png") });
  // Native app-zoom accelerators must leave the existing PDF-local keys alone.
  await fs.copyFile(pdfPath, path.join(project, "preview.pdf"));
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (
          await import("/src/renderer/stores/document-store.ts")
        ).useDocumentStore
          .getState()
          .files.some((file) => file.id === "preview.pdf"),
      ),
    )
    .toBe(true);
  await page.evaluate(async () =>
    (await import("/src/renderer/stores/document-store.ts")).useDocumentStore
      .getState()
      .setActiveFile("preview.pdf"),
  );
  await page.locator("[data-local-zoom-shortcuts]").first().click();
  await expect
    .poll(async () => (await menu("zoom-in"))?.accelerator)
    .toBeFalsy();
  await click("find");
  const pdfSearch = page.getByTestId("preview-search-panel");
  await expect(pdfSearch).toBeVisible();
  await pdfSearch.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("pdf-scroll-container")).toBeFocused();
  await expect
    .poll(async () => (await menu("zoom-in"))?.accelerator)
    .toBeFalsy();
  const windowHandle = await app.browserWindow(page);
  const zoom = await windowHandle.evaluate((win) =>
    win.webContents.getZoomFactor(),
  );
  await page.keyboard.press("Meta+=");
  assert.equal(
    await windowHandle.evaluate((win) => win.webContents.getZoomFactor()),
    zoom,
  );
  await click("zoom-in");
  await expect
    .poll(() => windowHandle.evaluate((win) => win.webContents.getZoomFactor()))
    .toBeGreaterThan(zoom);
  await click("zoom-reset");
  await expect
    .poll(() => windowHandle.evaluate((win) => win.webContents.getZoomFactor()))
    .toBe(1);
  await page.evaluate(async () =>
    (await import("/src/renderer/stores/document-store.ts")).useDocumentStore
      .getState()
      .setActiveFile("notes.md"),
  );

  await page.evaluate(async () => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.setState({
      keyboardShortcutOverrides: {
        "new-window": "Mod+Alt+KeyN",
        "save-file": "Mod+Shift+KeyS",
      },
    });
  });
  await expect
    .poll(async () => (await menu("new-window"))?.accelerator)
    .toBe("CommandOrControl+Alt+N");
  // The configured keyboard shortcut must create exactly one window.
  const opened = app.waitForEvent("window");
  await page.keyboard.press("Meta+Alt+n");
  const second = await ready(await opened);
  await focus(second);
  assert.equal(app.windows().length, 2);
  await expect
    .poll(async () => Boolean((await menu("save-file"))?.enabled))
    .toBe(false);
  await expect.poll(async () => await menu("inline:bold")).toBe(null);
  await expect
    .poll(async () => (await menu("new-window"))?.accelerator)
    .toBe("CommandOrControl+Alt+N");
  const settingsOpened = app.waitForEvent("window");
  await click("open-settings");
  const settings = await ready(await settingsOpened);
  await focus(settings);
  await expect
    .poll(async () => Boolean((await menu("save-file"))?.enabled))
    .toBe(false);
  await settings.getByRole("button", { name: "Keyboard", exact: true }).click();
  await settings.locator('[data-shortcut-action="new-window"]').click();
  await settings.keyboard.press("Meta+Alt+n");
  await expect(
    settings.getByRole("button", {
      name: "Change New Window shortcut",
      exact: true,
    }),
  ).toBeVisible();
  assert.equal(app.windows().length, 3);
  await settings.screenshot({
    path: path.join(artifacts, "keyboard-settings.png"),
  });
  const settingsClosed = settings.waitForEvent("close");
  await (await app.browserWindow(settings)).evaluate((win) => win.close());
  await settingsClosed;
  await focus(page);
  await expect.poll(async () => (await menu("save-file"))?.enabled).toBe(true);
  await click("close-project");
  await expect
    .poll(async () => Boolean((await menu("save-file"))?.enabled))
    .toBe(false);
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const recent = Menu.getApplicationMenu()
      .items.find((item) => item.label === "File")
      .submenu.items.find((item) => item.label === "Open Recent Projects");
    if (!recent.enabled || !recent.submenu.items.length)
      throw new Error("Recent project is missing");
    recent.submenu.items[0].click(undefined, BrowserWindow.getFocusedWindow());
  });
  await expect(page.locator(".cm-content")).toContainText("**Hello** menu");
  const panelOpened = app.waitForEvent("window");
  await page.evaluate(async () =>
    (await import("/src/renderer/lib/panel-windows.ts")).openPanelWindow(
      "editor",
      "duet",
    ),
  );
  const panel = await panelOpened;
  await expect(panel.locator(".cm-content")).toContainText("**Hello** menu");
  await focus(panel);
  await expect.poll(async () => (await menu("save-file"))?.enabled).toBe(true);
  await expect.poll(async () => await menu("close-project")).toBe(null);
  const panelClosed = panel.waitForEvent("close");
  await (await app.browserWindow(panel)).evaluate((win) => win.close());
  await panelClosed;
  await focus(page);
  await expect.poll(async () => (await menu("save-file"))?.enabled).toBe(true);
  await app.close();
  app = undefined;
  page = await launch();
  await focus(page);
  await expect
    .poll(async () => (await menu("new-window"))?.accelerator)
    .toBe("CommandOrControl+Alt+N");
  await openProject(page);
  await expect(page.locator(".cm-content")).toContainText("**Hello** menu");
  assert.deepEqual(errors, []);
  console.log(
    "Native menus: formatting, focus gating, find/replace, file dialogs, PDF export, project lifecycle, multi-window shortcuts and full restart passed.",
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
