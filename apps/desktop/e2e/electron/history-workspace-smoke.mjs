import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-history-workspace-"),
);
const project = path.join(profile, "Research notes");
// Keep native evidence outside Playwright's test-results cleanup lifecycle.
const resultRoot = path.join(os.tmpdir(), "catalex-history-review-artifacts");
const sourcePath = path.join(project, "notes.md");
const selectedText = [
  "# Research notes",
  "",
  "The first complete account of the experiment.",
  "",
  "## Methods",
  "We compare the two approaches under the same conditions.",
  "",
  "## Results",
  "The initial measurements support the working hypothesis.",
  "",
].join("\n");
const latestText = selectedText
  .replace("first complete account", "revised account")
  .replace("initial measurements", "expanded measurements");
const unsavedText = `${latestText}\nA thought that has not been saved yet.\n`;

// A tiny valid PDF figure makes asset provenance visible in the rendered result.
function figurePdf(color) {
  const stream = `${color} rg\n0 0 40 40 re f\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 40 40] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function captureSources(root, prefix = "") {
  const files = {};
  for (const entry of await fs.readdir(path.join(root, prefix), {
    withFileTypes: true,
  })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await captureSources(root, relative));
    } else if (entry.isFile()) {
      files[relative] = (await fs.readFile(path.join(root, relative))).toString(
        "base64",
      );
    }
  }
  return files;
}

await fs.mkdir(project);
await fs.mkdir(resultRoot, { recursive: true });
await fs.writeFile(sourcePath, "# Research notes\n\nOpening draft.\n");
let app;
let vite;
let deadline;

try {
  const run = async () => {
    vite = await createServer({
      root: desktopRoot,
      server: { host: "127.0.0.1", port: 0 },
    });
    await vite.listen();
    const env = {
      ...process.env,
      CATALEX_USER_DATA_DIR: profile,
      CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [desktopRoot], env, timeout: 20_000 });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1440, 960);
    });
    page.setDefaultTimeout(15_000);
    await page.locator("#loading-screen").waitFor({ state: "hidden" });

    const seeded = await page.evaluate(
      async ({ root, selectedText, latestText, unsavedText }) => {
        const { useDocumentStore: docs } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        const { useHistoryStore: history } = await import(
          "/src/renderer/stores/history-store.ts"
        );
        await docs.getState().openProject(root);
        await history.getState().init(root);
        await history.getState().loadSnapshots(root);
        const initial = history.getState().snapshots[0];
        const file = docs
          .getState()
          .files.find((item) => item.relativePath === "notes.md");
        if (!file || !initial) throw new Error("Native project setup failed");
        docs.getState().setActiveFile(file.id);
        docs.getState().updateFileContent("notes.md", selectedText);
        await docs.getState().saveCurrentFile();
        const selected = history.getState().snapshots[0];
        await history
          .getState()
          .addLabel(root, selected.id, "submission-draft");
        docs.getState().updateFileContent("notes.md", latestText);
        await docs.getState().saveCurrentFile();
        const latest = history.getState().snapshots[0];
        docs.getState().updateFileContent("notes.md", unsavedText);
        return {
          initialId: initial.id,
          selectedId: selected.id,
          latestId: latest.id,
          snapshotIds: history.getState().snapshots.map((item) => item.id),
        };
      },
      { root: project, selectedText, latestText, unsavedText },
    );
    assert.equal(new Set(seeded.snapshotIds).size, 3);
    assert.equal(await fs.readFile(sourcePath, "utf8"), latestText);

    // From here, enter, navigate, and restore through the actual app controls.
    await page.getByRole("button", { name: "History", exact: true }).click();
    const card = page.getByTestId("history-front-card");
    await expect(card).toBeVisible();
    if (process.platform === "darwin") {
      const inset = page.locator(
        '.history-stage-header > div[aria-hidden="true"]',
      );
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setFullScreen(true),
      );
      await expect(inset).toHaveCSS("width", "0px");
      await page.screenshot({
        path: path.join(resultRoot, "native-rewind-fullscreen.png"),
        animations: "disabled",
      });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setFullScreen(false),
      );
      await expect(inset).toHaveCSS("width", "72px");
      console.log(
        "Native fullscreen: Project rewind removes the traffic-light inset and restores it after exit.",
      );
    }

    await page.getByTestId("history-now").click();
    await expect(page.getByTestId("history-now")).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(card.locator(".cm-content")).toContainText(
      "A thought that has not been saved yet.",
    );
    await expect(card.locator(".cm-content")).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    await expect(
      card.getByRole("button", {
        name: "Restore project version",
        exact: true,
      }),
    ).toHaveCount(0);
    assert.equal(await fs.readFile(sourcePath, "utf8"), latestText);
    await page.screenshot({
      path: path.join(resultRoot, "native-history-now.png"),
      animations: "disabled",
    });
    await page.getByTestId(`history-snapshot-${seeded.selectedId}`).click();
    await expect(
      page.getByTestId(`history-snapshot-${seeded.selectedId}`),
    ).toHaveAttribute("aria-current", "true");
    await expect(card.getByTestId("history-file-notes.md")).toBeVisible();
    const diff = card.locator(".history-snapshot-source .cm-merge-b");
    await expect(diff).toContainText("first complete account");
    await expect(diff.locator(".cm-deletedChunk")).toContainText([
      "revised account",
      "expanded measurements",
    ]);
    await expect(diff.locator(".cm-content")).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    assert.equal(
      await card
        .locator(
          '[class*="traffic-light"], [data-window-drag-region], [data-window-controls], [aria-label="Minimize window"], [aria-label="Maximize window"], [aria-label="Close window"]',
        )
        .count(),
      0,
      "Preview cards must not duplicate native window controls",
    );
    await expect(page.locator(".history-rear-card")).toHaveCount(1);
    await expect(page.locator(".history-live-workspace")).toHaveAttribute(
      "inert",
      "",
    );
    await expect(
      card.getByRole("button", { name: "Restore project version" }),
    ).toBeEnabled();
    await page.screenshot({
      path: path.join(resultRoot, "native-history-workspace.png"),
      animations: "disabled",
    });
    await card.getByRole("button", { name: "Restore project version" }).click();
    const confirmation = page.getByRole("group", {
      name: "Confirm restore",
      exact: true,
    });
    await expect(confirmation).toBeVisible();
    await confirmation
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await expect(card).toBeHidden({ timeout: 20_000 });
    assert.equal(await fs.readFile(sourcePath, "utf8"), selectedText);

    const restored = await page.evaluate(async (root) => {
      const { useDocumentStore: docs } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      const { useHistoryStore: history } = await import(
        "/src/renderer/stores/history-store.ts"
      );
      const snapshots = history.getState().snapshots;
      const preserved = snapshots.find((item) =>
        item.message.startsWith("[before-restore]"),
      );
      return {
        snapshotIds: snapshots.map((item) => item.id),
        content: docs
          .getState()
          .files.find((item) => item.relativePath === "notes.md")?.content,
        preservedContent: preserved
          ? await history.getState().getFileAt(root, preserved.id, "notes.md")
          : null,
      };
    }, project);
    assert.equal(restored.content, selectedText);
    assert.equal(restored.preservedContent, unsavedText);
    for (const id of seeded.snapshotIds) {
      assert.ok(restored.snapshotIds.includes(id), "Prior history is retained");
    }
    assert.equal(restored.snapshotIds.length, seeded.snapshotIds.length + 2);
    await expect(page.locator(".history-live-workspace")).not.toHaveAttribute(
      "inert",
      "",
    );
    console.log(
      "Native Electron history UI fetched snapshot text, displayed a read-only diff without duplicate window controls, restored through confirmation, and preserved saved and unsaved history.",
    );
    console.log(
      `Native history screenshot: ${path.join(resultRoot, "native-history-workspace.png")}`,
    );

    // This second fixture proves complete snapshot enumeration and selected
    // current media viewing without introducing historical compilation.
    const mediaProject = path.join(profile, "History source and assets");
    const historicalTex =
      "\\documentclass{article}\n\\begin{document}\nHistorical source.\n\\end{document}\n";
    const currentTex = historicalTex.replace(
      "Historical source",
      "Current source",
    );
    const imageSvg = (color) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="${color}"/></svg>`;
    await fs.mkdir(path.join(mediaProject, "chapters"), { recursive: true });
    await fs.mkdir(path.join(mediaProject, "assets"));
    await fs.writeFile(path.join(mediaProject, "main.tex"), historicalTex);
    await fs.writeFile(
      path.join(mediaProject, "chapters/body.tex"),
      "Unchanged chapter.\n",
    );
    await fs.writeFile(
      path.join(mediaProject, "retired.tex"),
      "Old appendix.\n",
    );
    await fs.writeFile(
      path.join(mediaProject, "notes.md"),
      "# Unchanged notes\n",
    );
    await fs.writeFile(
      path.join(mediaProject, "assets/figure.pdf"),
      figurePdf("1 0 0"),
    );
    await fs.writeFile(
      path.join(mediaProject, "assets/image.svg"),
      imageSvg("#ff0000"),
    );
    const historicalId = await page.evaluate(async (root) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      await invoke("history_init", { projectRoot: root });
      const snapshots = await invoke("history_list", {
        projectRoot: root,
        limit: 10,
        offset: 0,
      });
      return snapshots[0].id;
    }, mediaProject);
    await fs.writeFile(path.join(mediaProject, "main.tex"), currentTex);
    await fs.rm(path.join(mediaProject, "retired.tex"));
    await fs.writeFile(path.join(mediaProject, "later.tex"), "New appendix.\n");
    await fs.writeFile(
      path.join(mediaProject, "assets/figure.pdf"),
      figurePdf("0 0 1"),
    );
    await fs.writeFile(
      path.join(mediaProject, "assets/image.svg"),
      imageSvg("#0000ff"),
    );
    const sourceBefore = await captureSources(mediaProject);
    const enumeration = await page.evaluate(
      async ({ root, snapshotId }) => {
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        const latest = await invoke("history_snapshot", {
          projectRoot: root,
          message: "Current source and media",
        });
        const files = await invoke("history_snapshot_files", {
          projectRoot: root,
          snapshotId,
        });
        const latestFiles = await invoke("history_snapshot_files", {
          projectRoot: root,
          snapshotId: latest.id,
        });
        const historicalSource = await invoke("history_file_at", {
          projectRoot: root,
          snapshotId,
          filePath: "main.tex",
        });
        return { files, latestFiles, historicalSource };
      },
      { root: mediaProject, snapshotId: historicalId },
    );
    assert.deepEqual(enumeration.files, [
      "chapters/body.tex",
      "main.tex",
      "notes.md",
      "retired.tex",
    ]);
    assert.deepEqual(enumeration.latestFiles, [
      "chapters/body.tex",
      "later.tex",
      "main.tex",
      "notes.md",
    ]);
    assert.equal(enumeration.historicalSource, historicalTex);
    assert.deepEqual(await captureSources(mediaProject), sourceBefore);

    await page.evaluate(async (root) => {
      const { useDocumentStore: docs } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      await docs.getState().openProject(root);
      const main = docs
        .getState()
        .files.find((file) => file.relativePath === "main.tex");
      if (!main) throw new Error("History fixture main file missing");
      docs.getState().setActiveFile(main.id);
    }, mediaProject);
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(card).toBeVisible();
    await page.getByTestId(`history-snapshot-${historicalId}`).click();
    await expect(card.getByTestId("history-file-notes.md")).toBeVisible();
    await expect(card.getByTestId("history-file-retired.tex")).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Split editor and PDF" }),
    ).toHaveCount(0);
    await card.getByTestId("history-file-main.tex").click();
    const sourcePanel = card.locator('[data-history-panel="source"]');
    const mediaPanel = card.locator('[data-history-panel="media"]');
    await expect(sourcePanel).toBeVisible();
    await expect(sourcePanel.locator(".cm-content")).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    await expect(sourcePanel).toContainText("Historical source");
    await expect(mediaPanel).toHaveCount(0);
    await card.getByTestId("history-file-notes.md").click();
    await expect(sourcePanel).toContainText("Unchanged notes");
    const assetsFolder = card.getByRole("button", {
      name: "assets",
      exact: true,
    });
    if ((await assetsFolder.getAttribute("aria-expanded")) !== "true")
      await assetsFolder.click();
    await card.getByTestId("history-file-assets/figure.pdf").click();
    await expect(mediaPanel).toBeVisible();
    await expect(sourcePanel).toHaveCount(0);
    await expect(mediaPanel).toContainText(/current/i);
    await page.waitForFunction(
      () =>
        [
          ...document.querySelectorAll('[data-history-panel="media"] canvas'),
        ].some((canvas) => {
          if (canvas.width < 20 || canvas.height < 20) return false;
          const pixels = canvas
            .getContext("2d")
            ?.getImageData(0, 0, canvas.width, canvas.height).data;
          if (!pixels) return false;
          for (let index = 0; index < pixels.length; index += 4) {
            if (
              pixels[index] < 80 &&
              pixels[index + 1] < 80 &&
              pixels[index + 2] > 180 &&
              pixels[index + 3] > 0
            )
              return true;
          }
          return false;
        }),
      undefined,
      { timeout: 30_000 },
    );
    await page.screenshot({
      path: path.join(resultRoot, "native-history-current-pdf.png"),
      animations: "disabled",
    });
    await card.getByTestId("history-file-assets/image.svg").click();
    await expect(mediaPanel.locator("img")).toBeVisible();
    await expect(sourcePanel).toHaveCount(0);
    await page.waitForFunction(() => {
      const image = document.querySelector('[data-history-panel="media"] img');
      if (!image?.complete || !image.naturalWidth) return false;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, 1, 1);
      const pixel = context.getImageData(0, 0, 1, 1).data;
      return pixel[0] < 80 && pixel[1] < 80 && pixel[2] > 180 && pixel[3] > 0;
    });
    await page.screenshot({
      path: path.join(resultRoot, "native-history-current-image.png"),
      animations: "disabled",
    });
    await card.getByTestId("history-file-main.tex").click();
    await expect(sourcePanel).toContainText("Historical source");
    await expect(mediaPanel).toHaveCount(0);
    await page.getByRole("button", { name: "Back to present" }).click();
    await expect(card).toBeHidden();
    assert.deepEqual(await captureSources(mediaProject), sourceBefore);
    console.log(
      "Native history passed: complete recorded file lists, historical text, selected current PDF/image assets in one pane, and unchanged project files.",
    );
    console.log(
      `Native media screenshots: ${path.join(resultRoot, "native-history-current-pdf.png")} and ${path.join(resultRoot, "native-history-current-image.png")}`,
    );
  };
  await Promise.race([
    run(),
    new Promise((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error("Native history smoke exceeded 90 seconds")),
        90_000,
      );
    }),
  ]);
} finally {
  clearTimeout(deadline);
  try {
    if (app) {
      const forceClose = setTimeout(() => app.process().kill("SIGKILL"), 5_000);
      try {
        await app.close();
      } finally {
        clearTimeout(forceClose);
      }
    }
  } finally {
    if (vite) await vite.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}
