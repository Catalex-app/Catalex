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
  "../../output/playwright/electron/menu-views",
);
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(path.join(project, "notes.md"), "Hello menu\n");
await fs.writeFile(
  path.join(project, "main.tex"),
  "\\documentclass{article}\n\\begin{document}\nHello LaTeX\n\\end{document}\n",
);
await fs.writeFile(path.join(project, "plain.txt"), "Plain text\n");
await fs.copyFile(
  path.join(desktopRoot, "public/examples/paper-standard/main.pdf"),
  path.join(project, "paper.pdf"),
);
await fs.writeFile(path.join(project, "data.csv"), "name,value\na,1\n");
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
          label: item.label,
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
async function checkReadOnlyFormatting(page) {
  const editor = page.locator(".cm-content");
  const bold = page.getByRole("button", { name: "Bold", exact: true });
  await editor.click();
  await expect
    .poll(async () => (await menu("inline:bold"))?.enabled)
    .toBe(true);
  // Lock the editor itself without setting any agent/menu flags. Both menu
  // and toolbar must follow it, including locks introduced by future features.
  for (const kind of ["readOnly", "editable"]) {
    const handle = await page.evaluateHandle(async (kind) => {
      const { EditorView } = await import(
        "/node_modules/.vite/deps/@codemirror_view.js"
      );
      const { Compartment, EditorState, Prec, StateEffect } = await import(
        "/node_modules/.vite/deps/@codemirror_state.js"
      );
      const view = EditorView.findFromDOM(
        document.querySelector(".cm-content"),
      );
      const lock = new Compartment();
      view.dispatch({
        effects: StateEffect.appendConfig.of(
          lock.of(
            Prec.highest(
              kind === "readOnly"
                ? EditorState.readOnly.of(true)
                : EditorView.editable.of(false),
            ),
          ),
        ),
      });
      return { view, lock };
    }, kind);
    await expect(bold).toBeDisabled();
    await expect
      .poll(async () => (await menu("inline:bold"))?.enabled)
      .toBe(false);
    await handle.evaluate(({ view, lock }) =>
      view.dispatch({ effects: lock.reconfigure([]) }),
    );
    await handle.dispose();
    await expect(bold).toBeEnabled();
    await editor.click();
    await expect
      .poll(async () => (await menu("inline:bold"))?.enabled)
      .toBe(true);
  }
  for (const flag of ["isApplyingAgentDraft", "isAgentWorkspaceReadOnly"]) {
    const before = await editor.innerText();
    await page.evaluate(async (flag) => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      useDocumentStore.setState({ [flag]: true });
    }, flag);
    await expect(bold).toBeDisabled();
    await expect
      .poll(async () => (await menu("inline:bold"))?.enabled)
      .toBe(false);
    await bold.evaluate((button) => button.click());
    await expect.poll(() => editor.innerText()).toBe(before);
    await page.evaluate(async (flag) => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      useDocumentStore.setState({ [flag]: false });
    }, flag);
    await expect(bold).toBeEnabled();
    await editor.click();
    await expect
      .poll(async () => (await menu("inline:bold"))?.enabled)
      .toBe(true);
  }
}
async function choose(page, command, label, workspace = false) {
  await click(command);
  const controls = page.getByRole("tablist", {
    name: workspace ? "Chat workspace content" : "Workspace view mode",
    exact: true,
  });
  await expect(
    controls.getByRole("tab", { name: label, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await menu(command))?.checked).toBe(true);
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
}
async function file(page, id) {
  await page.evaluate(
    async (id) =>
      (await import("/src/renderer/stores/document-store.ts")).useDocumentStore
        .getState()
        .setActiveFile(id),
    id,
  );
}
try {
  const page = await launch();
  await focus(page);
  for (const id of ["view:editor", "view:split", "view:preview"]) {
    await expect.poll(async () => await menu(id)).toBe(null);
  }
  await openProject(page);
  await choose(page, "view:editor", "Editor");
  await checkReadOnlyFormatting(page);
  await choose(page, "view:preview", "Preview");
  await choose(page, "view:split", "Split");
  await page
    .getByRole("tablist", { name: "Workspace view mode" })
    .getByRole("tab", { name: "Editor", exact: true })
    .click();
  await expect
    .poll(async () => (await menu("view:editor"))?.checked)
    .toBe(true);
  await choose(page, "view:split", "Split");
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifacts, "markdown-split.png"),
  });
  // Only the focused panel contributes its window actions, including iframe focus.
  await page.getByRole("tab", { name: "Split", exact: true }).click();
  for (const id of ["panel:expand", "panel:pop-out"])
    await expect.poll(() => menu(id)).toBe(null);
  for (const label of ["Editor", "Preview"]) {
    if (label === "Editor") await page.locator(".cm-content").click();
    else
      await page
        .frameLocator('iframe[title="notes.md preview"]')
        .locator("#write")
        .click();
    // Generic panel labels no longer change when focus moves. Wait for the
    // same native menu update via formatting's focus-dependent availability.
    await expect
      .poll(async () => (await menu("inline:bold"))?.enabled)
      .toBe(label === "Editor");
    await expect
      .poll(async () => (await menu("panel:expand"))?.label)
      .toBe("Expand Focused Panel");
    await expect
      .poll(async () => (await menu("panel:pop-out"))?.label)
      .toBe("Pop Out Focused Panel");
    const sections = await app.evaluate(({ Menu }) => {
      const items = Menu.getApplicationMenu().items.find(
        (item) => item.label === "View",
      ).submenu.items;
      const sections = [[]];
      for (const item of items) {
        if (item.type === "separator") sections.push([]);
        else sections.at(-1).push(item.id);
      }
      return sections;
    });
    assert.deepEqual(sections[1], ["panel:expand", "panel:pop-out"]);
    await click("panel:expand");
    const expanded = page.getByRole("dialog", {
      name: `${label} expanded`,
      exact: true,
    });
    await expect(expanded).toBeVisible();
    await expect(expanded).not.toHaveAttribute("data-panel-expansion-motion");
    await expect
      .poll(async () => (await menu("panel:expand"))?.label)
      .toBe("Restore Focused Panel");
    await page.screenshot({
      path: path.join(artifacts, `menu-expanded-${label.toLowerCase()}.png`),
    });
    await click("panel:expand");
    await expect(expanded).toHaveCount(0);
    await expect
      .poll(async () => (await menu("view:split"))?.checked)
      .toBe(true);
  }
  for (const label of ["Editor", "Preview"]) {
    // Exercise the user's actual double-click gesture, not just the overflow menu.
    const header = page.locator("[data-workspace-panel-header]").filter({
      has: page.getByRole("button", {
        name: `More ${label} view actions`,
        exact: true,
      }),
    });
    await header.dblclick({ position: { x: 450, y: 24 } });
    const expanded = page.getByRole("dialog", {
      name: `${label} expanded`,
      exact: true,
    });
    await expect(expanded).not.toHaveAttribute("data-panel-expansion-motion");
    for (const id of ["view:editor", "view:split", "view:preview"]) {
      await expect.poll(async () => await menu(id)).toBe(null);
    }
    if (label === "Editor") {
      const editor = expanded.locator(".cm-content");
      await editor.click();
      await page.keyboard.press("Meta+a");
      await page.keyboard.press("ArrowLeft");
      for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
      await expect
        .poll(async () => (await menu("inline:bold"))?.enabled)
        .toBe(true);
      await expect
        .poll(async () => (await menu("add-comment"))?.enabled)
        .toBe(true);
      await click("inline:bold");
      await expect(editor).toContainText("**Hello** menu");
      // The existing toolbar uses the same action and reverses the formatting.
      await expanded
        .getByRole("button", { name: "Bold", exact: true })
        .filter({ visible: true })
        .click();
      await expect(editor).toHaveText("Hello menu");
      await page.screenshot({
        path: path.join(artifacts, "expanded-editor.png"),
      });
    }
    await expanded
      .getByRole("button", { name: `Restore ${label}`, exact: true })
      .click();
    await expect(expanded).toHaveCount(0);
    await expect
      .poll(async () => (await menu("view:split"))?.checked)
      .toBe(true);
  }
  await file(page, "data.csv");
  await expect
    .poll(async () => (await menu("view:preview"))?.label)
    .toBe("Table");
  await choose(page, "view:editor", "Raw");
  await choose(page, "view:preview", "Table");
  await expect(page.getByTestId("csv-table")).toBeVisible();
  await choose(page, "view:split", "Split");
  await file(page, "plain.txt");
  await expect(page.locator(".cm-content")).toContainText("Plain text");
  for (const id of ["view:editor", "view:split", "view:preview"]) {
    await expect.poll(async () => await menu(id)).toBe(null);
  }
  // A standalone PDF uses the editor panel and the same focused-panel actions.
  await file(page, "paper.pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByTestId("pdf-scroll-container")
    .click({ position: { x: 100, y: 100 } });
  // The hidden compiled preview must not disable the standalone PDF's action.
  const exportedPdf = path.join(profile, "exported-paper.pdf");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exportedPdf);
  await click("export-pdf");
  const originalPdf = await fs.readFile(path.join(project, "paper.pdf"));
  await expect
    .poll(async () =>
      fs.readFile(exportedPdf).then(
        (bytes) => bytes.equals(originalPdf),
        () => false,
      ),
    )
    .toBe(true);
  await expect(
    page
      .locator('[data-drawer-shell="true"]')
      .getByRole("button", { name: "More Editor view actions", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await menu("panel:expand"))?.label)
    .toBe("Expand Focused Panel");
  await expect
    .poll(async () => (await menu("panel:pop-out"))?.label)
    .toBe("Pop Out Focused Panel");
  await click("panel:expand");
  const standalone = page.getByRole("dialog", {
    name: "Editor expanded",
    exact: true,
  });
  await expect(standalone).toBeVisible();
  await expect(standalone).not.toHaveAttribute("data-panel-expansion-motion");
  await expect
    .poll(async () => (await menu("panel:expand"))?.label)
    .toBe("Restore Focused Panel");
  await page.screenshot({
    path: path.join(artifacts, "standalone-pdf-expanded.png"),
  });
  await click("panel:expand");
  await expect(standalone).toHaveCount(0);
  const pdfOpened = app.waitForEvent("window");
  await click("panel:pop-out");
  const pdfPanel = await ready(await pdfOpened);
  await focus(pdfPanel);
  await expect(pdfPanel.locator(".mupdf-text-layer").first()).toBeVisible();
  await expect(
    pdfPanel.getByRole("button", {
      name: "More Editor view actions",
      exact: true,
    }),
  ).toBeVisible();
  await pdfPanel
    .getByTestId("pdf-scroll-container")
    .click({ position: { x: 100, y: 100 } });
  for (const id of ["panel:expand", "panel:pop-out"])
    await expect.poll(() => menu(id)).toBe(null);
  const pdfClosed = pdfPanel.waitForEvent("close");
  await (await app.browserWindow(pdfPanel)).evaluate((win) => win.close());
  await pdfClosed;
  await focus(page);
  await file(page, "main.tex");
  await choose(page, "view:preview", "PDF");
  await choose(page, "view:editor", "Editor");
  await checkReadOnlyFormatting(page);
  await choose(page, "view:split", "Split");
  // Use the existing control to enter the agent workspace.
  await page
    .locator('[data-chat-display="Workspace"]')
    .evaluate((el) => el.click());
  await expect(
    page.getByRole("tablist", { name: "Chat workspace content", exact: true }),
  ).toBeVisible();
  await expect.poll(async () => await menu("view:split")).toBe(null);
  await choose(page, "view:editor", "Editor", true);
  await choose(page, "view:preview", "PDF", true);
  await page
    .getByRole("button", { name: "More Chat view actions", exact: true })
    .focus();
  await expect
    .poll(async () => (await menu("panel:expand"))?.label)
    .toBe("Expand Focused Panel");
  await click("panel:expand");
  const chat = page.getByRole("dialog", { name: "Chat expanded", exact: true });
  await expect(chat).toBeVisible();
  await expect(chat).not.toHaveAttribute("data-panel-expansion-motion");
  for (const id of ["view:editor", "view:split", "view:preview"]) {
    await expect.poll(async () => await menu(id)).toBe(null);
  }
  await page.keyboard.press("Escape");
  await expect(chat).toHaveCount(0);
  await choose(page, "view:editor", "Editor", true);
  await choose(page, "view:preview", "PDF", true);
  await page.screenshot({ path: path.join(artifacts, "agent-workspace.png") });
  await choose(page, "view:editor", "Editor", true);
  await page.locator(".cm-content").click();
  await expect
    .poll(async () => (await menu("panel:pop-out"))?.label)
    .toBe("Pop Out Focused Panel");
  const opened = app.waitForEvent("window");
  await click("panel:pop-out");
  const panel = await ready(await opened);
  await focus(panel);
  await panel.locator(".cm-content").click();
  for (const id of [
    "view:editor",
    "view:split",
    "view:preview",
    "panel:expand",
    "panel:pop-out",
  ]) {
    await expect.poll(async () => await menu(id)).toBe(null);
  }
  const closed = panel.waitForEvent("close");
  await (await app.browserWindow(panel)).evaluate((win) => win.close());
  await closed;
  await focus(page);
  // Layout switching remains available with read-only agent draft content.
  const wasReadOnly = await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const previous = useDocumentStore.getState().isAgentWorkspaceReadOnly;
    useDocumentStore.setState({ isAgentWorkspaceReadOnly: true });
    return previous;
  });
  try {
    await choose(page, "view:editor", "Editor", true);
    await choose(page, "view:preview", "PDF", true);
  } finally {
    // A simulated source lock must not reach the real save-before-quit path.
    await page.evaluate(async (previous) => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      useDocumentStore.setState({ isAgentWorkspaceReadOnly: previous });
    }, wasReadOnly);
  }
  // Exercise normal quit while Playwright remains connected. A save warning
  // must fail this check rather than leave a dialog waiting during teardown.
  const appClosed = app.waitForEvent("close", { timeout: 15000 });
  await app.evaluate(({ app }) => app.quit());
  await appClosed;
  app = undefined;
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    "Hello menu\n",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Native View menu: existing Markdown/LaTeX/CSV switches, one-column availability, toolbar synchronization, agent workspace, hidden switches in expanded chat and pop-outs, focused panel expand/restore/pop-out actions including standalone PDFs, read-only content, and normal save-before-quit passed.",
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
