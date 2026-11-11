import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-context-menu-"),
);
const project = path.join(profile, "Menu project");
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/context-menu",
);
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(
  path.join(project, "notes.md"),
  "# Clipboard check\n\nOriginal document.\n",
);
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
const app = await electron.launch({
  args: [desktopRoot],
  env,
  timeout: 30_000,
});
try {
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    globalThis.__savedContextMenuClipboard = await Promise.all(
      (await clipboard.read()).map(
        async (item) =>
          new ClipboardItem(
            Object.fromEntries(
              await Promise.all(
                item.types.map(async (type) => [
                  type,
                  await item.getType(type),
                ]),
              ),
            ),
          ),
      ),
    );
  });
  await app.evaluate(({ clipboard }) =>
    clipboard.writeText("Context menu test clipboard"),
  );
  const page = await app.firstWindow();
  const win = await app.browserWindow(page);
  await win.evaluate((window) => {
    const setIgnore = window.webContents.setIgnoreMenuShortcuts.bind(
      window.webContents,
    );
    window.webContents.setIgnoreMenuShortcuts = (ignore) => {
      window.__contextMenuShortcutsIgnored = ignore;
      setIgnore(ignore);
    };
  });
  await win.evaluate((window) => {
    window.setSize(1280, 900);
    window.show();
    window.focus();
  });
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await app.evaluate(({ dialog }, projectPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [projectPath],
    });
  }, project);
  await page.getByTestId("welcome-new-project-menu-trigger").click();
  await page
    .getByRole("menuitem", { name: "Open Folder", exact: true })
    .click();
  const editor = page.locator(".cm-content").first();
  await expect(editor).toContainText("Original document.");
  await editor.click();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+a" : "Control+a",
  );
  await editor.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Copy", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() => win.evaluate((window) => window.__contextMenuShortcutsIgnored))
    .toBe(true);
  const windowCount = app.windows().length;
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Shift+n" : "Control+Shift+n",
  );
  await expect(
    page.getByRole("menuitem", { name: "Copy", exact: true }),
  ).toBeVisible();
  expect(app.windows().length).toBe(windowCount);
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "electron-editor-menu.png"),
  });
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect
    .poll(() => win.evaluate((window) => window.__contextMenuShortcutsIgnored))
    .toBe(false);
  await expect
    .poll(() =>
      app.evaluate(async ({ clipboard }) =>
        (await clipboard.readText()).includes("Original document."),
      ),
    )
    .toBe(true);
  await app.evaluate(({ clipboard }) =>
    clipboard.writeText("Pasted through native clipboard"),
  );
  await editor.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Paste", exact: true }).click();
  await expect(editor).toHaveText("Pasted through native clipboard");
  await editor.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Undo", exact: true }).click();
  await expect(editor).toContainText("Original document.");
  // A menu read must not grant the page general browser clipboard access.
  expect(
    await page.evaluate(async () => {
      try {
        await navigator.clipboard.readText();
        return "allowed";
      } catch {
        return "denied";
      }
    }),
  ).toBe("denied");
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "electron-paste-undo.png"),
  });
  console.log(
    "Electron context menu copy, native paste, undo, and clipboard permission checks passed.",
  );
} finally {
  await app
    .evaluate(async ({ clipboard }) => {
      if (!globalThis.__savedContextMenuClipboard) return;
      if (globalThis.__savedContextMenuClipboard.length)
        await clipboard.write(globalThis.__savedContextMenuClipboard);
      else clipboard.clear();
      delete globalThis.__savedContextMenuClipboard;
    })
    .catch(() => {});
  await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
