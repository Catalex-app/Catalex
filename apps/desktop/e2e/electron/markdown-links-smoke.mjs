import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const artifacts = path.resolve(desktopRoot, "../../output/playwright");
await fs.mkdir(artifacts, { recursive: true });
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-markdown-links-"),
);
const project = path.join(profile, "Project");
await fs.mkdir(path.join(project, "docs"), { recursive: true });
await fs.mkdir(path.join(project, "assets"));
await fs.mkdir(path.join(project, "themes"));
await fs.writeFile(
  path.join(project, "themes", "rebuttal.css"),
  ":root { --bg-color: #ffffff; --text-color: #222222; }",
);
for (const name of ["a", "b", "c", "d", "e"])
  await fs.writeFile(
    path.join(project, "themes", `${name}.css`),
    "body { color: #222; }",
  );
const recentThemeNames = ["rebuttal", "a", "c", "d", "e"].map(
  (name) => `themes/${name}.css`,
);
const assertRecentOrder = async (page) => {
  await expect
    .poll(async () =>
      (await page.getByRole("menuitemradio").allTextContents())
        .map((name) => name.trim())
        .filter((name) => name.startsWith("themes/")),
    )
    .toEqual(recentThemeNames);
};
const asset = path.join(project, "assets", "sample [one].txt");
const note = path.join(project, "docs", "note.md");
await fs.writeFile(asset, "File content must not be inserted.");
await fs.writeFile(
  note,
  '# Note\n\n[Target](other.md#destination)\n\n<span style="color:red">Colored</span>\n\nInline $\\frac{a}{b}$.\n',
);
const target = "# Other\n\nBefore.\n\n## Destination\n\nFound it. $x^2$";
await fs.writeFile(path.join(project, "docs", "other.md"), target);
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
async function launch() {
  app = await electron.launch({ args: [desktopRoot], env });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.evaluate(async (project) => {
    const { useOnboardingStore } = await import(
      "/src/renderer/stores/onboarding-store.ts"
    );
    useOnboardingStore.getState().finish();
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(project);
    useDocumentStore.getState().setActiveFile("docs/note.md");
  }, project);
  return page;
}
try {
  let page = await launch();
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("# Note");
  await page.getByRole("button", { name: "Markdown preview settings" }).click();
  await page
    .getByRole("menuitemradio", { name: "MathJax (OpenReview)", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(
    page
      .frameLocator('iframe[title="note.md preview"]')
      .locator("mjx-container svg"),
  ).toHaveCount(1);
  // Exercise the actual renderer clone, preload IPC, and Chromium PDF export.
  const pdfPath = path.join(artifacts, "markdown-mathjax-export.pdf");
  await fs.rm(pdfPath, { force: true });
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, pdfPath);
  await page.getByRole("button", { name: "Export Markdown as PDF" }).click();
  await expect
    .poll(async () =>
      fs
        .stat(pdfPath)
        .then((stat) => stat.size)
        .catch(() => 0),
    )
    .toBeGreaterThan(1000);
  await expect(page.locator("[data-catalex-markdown-pdf-root]")).toHaveCount(0);
  const mupdf = await import("mupdf");
  const pdf = mupdf.Document.openDocument(
    await fs.readFile(pdfPath),
    "application/pdf",
  );
  assert.equal(pdf.countPages(), 1);
  const pdfPage = pdf.loadPage(0);
  const pdfText = pdfPage.toStructuredText();
  const inlinePositions = [];
  pdfText.walk({
    onChar(character, origin) {
      if (character === "I" || character === ".")
        inlinePositions.push({ character, x: origin[0], y: origin[1] });
    },
  });
  pdfText.destroy();
  assert.deepEqual(
    inlinePositions.map((position) => position.character),
    ["I", "."],
  );
  assert.ok(
    Math.abs(inlinePositions[0].y - inlinePositions[1].y) < 1,
    "Inline math must keep its surrounding prose on the same PDF line",
  );
  assert.ok(inlinePositions[1].x > inlinePositions[0].x);
  const pixmap = pdfPage.toPixmap(
    mupdf.Matrix.identity,
    mupdf.ColorSpace.DeviceRGB,
    false,
  );
  await fs.writeFile(
    path.join(artifacts, "markdown-mathjax-export.png"),
    pixmap.asPNG(),
  );
  pixmap.destroy();
  pdfPage.destroy();
  pdf.destroy();
  await page.getByRole("button", { name: "Markdown preview settings" }).click();
  await page
    .getByRole("menuitem", { name: "All Typora themes", exact: true })
    .click();
  await expect(
    page
      .getByRole("menuitemradio", { name: "themes/rebuttal.css", exact: true })
      .getByTestId("markdown-theme-swatch")
      .locator('[data-theme-color="background"]'),
  ).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page
    .getByRole("menuitemradio", { name: "themes/rebuttal.css", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  // Recency evicts b, but retained rows keep their original positions.
  await page.evaluate(async (project) => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    for (const name of ["a", "b", "c", "d", "a", "rebuttal", "e"])
      useSettingsStore
        .getState()
        .recordRecentMarkdownTheme(`${project}/themes/${name}.css`);
  }, project);
  const panelPromise = app.waitForEvent("window");
  await page.evaluate(async () => {
    const { openPanelWindow } = await import(
      "/src/renderer/lib/panel-windows.ts"
    );
    openPanelWindow("preview", "duet");
  });
  const panel = await panelPromise;
  const panelPreview = panel.frameLocator('iframe[title="note.md preview"]');
  await expect(panelPreview.locator("mjx-container svg")).toHaveCount(1);
  await panel
    .getByRole("button", { name: "Markdown preview settings" })
    .click();
  await expect(
    panel.getByRole("menuitemradio", {
      name: "themes/rebuttal.css",
      exact: true,
    }),
  ).toBeVisible();
  await assertRecentOrder(panel);
  await panel
    .getByRole("menuitemradio", { name: "KaTeX (fast)", exact: true })
    .click();
  await panel.keyboard.press("Escape");
  await expect(
    panel.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(
    page.frameLocator('iframe[title="note.md preview"]').locator(".katex"),
  ).toHaveCount(1);
  // A new global default syncs across windows without replacing this file's choice.
  await page.evaluate(async () => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    const { broadcastSettingsChanged } = await import(
      "/src/renderer/components/settings/solar-mode-effect.tsx"
    );
    useSettingsStore.getState().setDefaultMarkdownMathEngine("mathjax");
    broadcastSettingsChanged();
  });
  await expect
    .poll(() =>
      panel.evaluate(async () => {
        const { useSettingsStore } = await import(
          "/src/renderer/stores/settings-store.ts"
        );
        return useSettingsStore.getState().defaultMarkdownMathEngine;
      }),
    )
    .toBe("mathjax");
  await expect(panelPreview.locator(".katex")).toHaveCount(1);
  await panel
    .getByRole("button", { name: "Markdown preview settings" })
    .click();
  await panel
    .getByRole("menuitemradio", { name: "MathJax (OpenReview)", exact: true })
    .click();
  await panel.keyboard.press("Escape");
  await expect(
    panel.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(
    page
      .frameLocator('iframe[title="note.md preview"]')
      .locator("mjx-container svg"),
  ).toHaveCount(1);
  await panel.close();
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "native-drop-fixture";
    document.body.append(input);
  });
  await page.locator("#native-drop-fixture").setInputFiles(asset);
  const dispatchNativeDrag = (type) =>
    editor.evaluate((element, type) => {
      const file = document.querySelector("#native-drop-fixture").files[0];
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: rect.left + 50,
          clientY: rect.top + 10,
        }),
      );
    }, type);
  await dispatchNativeDrag("dragover");
  await expect(page.locator(".cm-markdown-file-drop-caret")).toBeVisible();
  await dispatchNativeDrag("drop");
  await expect(page.locator(".cm-markdown-file-drop-caret")).toHaveCount(0);
  await expect(editor).toContainText(
    "[sample \\[one\\].txt](../assets/sample%20%5Bone%5D.txt)",
  );
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().saveCurrentFile();
  });
  assert.match(
    await fs.readFile(note, "utf8"),
    /\.\.\/assets\/sample%20%5Bone%5D\.txt/,
  );
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.setState((state) => ({
      files: state.files.map((file) =>
        file.id === "docs/other.md" ? { ...file, content: undefined } : file,
      ),
    }));
  });
  await page
    .frameLocator('iframe[title="note.md preview"]')
    .getByRole("link", { name: "Target", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useDocumentStore } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        return useDocumentStore.getState().cursorPosition;
      }),
    )
    .toBe(target.indexOf("## Destination"));
  await expect(
    page
      .frameLocator('iframe[title="other.md preview"]')
      .locator("mjx-container svg"),
  ).toHaveCount(1);
  await expect(
    page.frameLocator('iframe[title="other.md preview"]').locator(".katex"),
  ).toHaveCount(0);
  await app.close();
  app = undefined;
  page = await launch();
  expect(
    await page.evaluate(async () => {
      const { useSettingsStore } = await import(
        "/src/renderer/stores/settings-store.ts"
      );
      const state = useSettingsStore.getState();
      return [
        state.defaultMarkdownMathEngine,
        state.getMarkdownMathEngineForFile("/another-project", "new.md"),
      ];
    }),
  ).toEqual(["mathjax", "mathjax"]);
  await page.getByRole("button", { name: "Markdown preview settings" }).click();
  await assertRecentOrder(page);
  await expect(
    page.getByRole("menuitemradio", {
      name: "themes/rebuttal.css",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(
    page
      .frameLocator('iframe[title="note.md preview"]')
      .locator("mjx-container svg"),
  ).toHaveCount(1);
  await expect(page.locator(".cm-content")).toContainText(
    "../assets/sample%20%5Bone%5D.txt",
  );
  assert.deepEqual(errors, []);
  console.log(
    "MathJax PDF export, recent themes and per-file math engines across windows and restart, native file drop, cross-file heading navigation, and saving passed with an isolated Electron profile.",
  );
} finally {
  await app?.close();
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
