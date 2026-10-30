// Generate the --latex fixture first; run from the repository root after build:desktop.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-pdf-range-"));
const project = path.join(profile, "paper");
const output = path.resolve("output/playwright/pdf-range");
await fs.mkdir(output, { recursive: true });
await fs.cp(
  path.resolve("output/playwright/pdf-switch-diagnostic/project"),
  project,
  { recursive: true },
);
const mainFile = path.join(project, "main.tex");
await fs.writeFile(
  mainFile,
  (await fs.readFile(mainFile, "utf8")).replace(
    "A representative LaTeX preview",
    "Unique range selection",
  ),
);
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
const app = await electron.launch({
  executablePath: process.env.CATALEX_PDF_RANGE_EXECUTABLE,
  args: process.env.CATALEX_PDF_RANGE_EXECUTABLE
    ? []
    : [path.resolve("apps/desktop")],
  env,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.waitForLoadState("load");
  await page.evaluate(() =>
    localStorage.setItem(
      "catalex-onboarding",
      JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
    ),
  );
  await page.reload();
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [project],
    });
    globalThis.__pdfRanges = [];
    const fs = process.getBuiltinModule("fs").promises;
    const open = fs.open;
    fs.open = async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).includes("/pdf-snapshots/")) {
        const read = handle.read;
        handle.read = async function (...readArgs) {
          if (readArgs[2] > 5)
            globalThis.__pdfRanges.push({
              file: String(args[0]),
              length: readArgs[2],
              offset: readArgs[3],
            });
          return read.apply(this, readArgs);
        };
      }
      return handle;
    };
  }, project);
  await page.getByTestId("welcome-new-project-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Open Folder" }).click();
  await page.locator(".cm-content").first().waitFor();
  const win = await app.browserWindow(page);
  await win.evaluate((w) => {
    w.unmaximize();
    w.setSize(1440, 1000);
  });
  await page
    .getByRole("button", { name: /Recompile/ })
    .first()
    .click();
  await expect(page.locator(".mupdf-page")).toHaveCount(16, {
    timeout: 120_000,
  });
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Unique range selection" })
    .first();
  await expect(line).toBeVisible();
  const initial = await app.evaluate(() => globalThis.__pdfRanges);
  const reads = initial;
  assert(reads.length > 0, "The actual PDF must use range requests");
  const initialBytes = reads.reduce((n, range) => n + range.length, 0);
  const files = await fs.readdir(path.join(profile, "pdf-snapshots"));
  const sizes = await Promise.all(
    files.map((name) =>
      fs.stat(path.join(profile, "pdf-snapshots", name)).then((s) => s.size),
    ),
  );
  assert(
    initialBytes < Math.max(...sizes),
    "Opening must not read the entire fixture",
  );
  console.log(
    "initial ranges",
    reads.length,
    "bytes",
    initialBytes,
    "PDF bytes",
    Math.max(...sizes),
  );
  await page.getByRole("tab", { name: "PDF", exact: true }).click();
  await page.waitForTimeout(700);
  await line.evaluate((element) => {
    const node = element.firstChild;
    const text = node.textContent;
    const start = text.indexOf("Unique range selection");
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.setBaseAndExtent(
      node,
      start,
      node,
      start + "Unique range selection".length,
    );
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
  await card
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Range loading preserves this comment");
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  console.log("Native PDF comment saved");
  const highlight = page
    .locator('[data-page-number="1"] [data-pdf-comment-highlight]')
    .first();
  await expect(highlight).toBeVisible();
  const commentId = await highlight.getAttribute("data-pdf-comment-id");
  await page.keyboard.press("Escape");
  await page
    .locator('[data-page-number="14"]')
    .evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(800);
  await page
    .locator('[data-page-number="1"]')
    .evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(highlight).toBeVisible();
  const previousFiles = new Set(
    (await app.evaluate(() => globalThis.__pdfRanges)).map((r) => r.file),
  );
  await page
    .getByRole("button", { name: /Recompile/ })
    .first()
    .click();
  await expect
    .poll(
      async () =>
        (await app.evaluate(() => globalThis.__pdfRanges)).filter(
          (r) => !previousFiles.has(r.file),
        ).length,
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0);
  await expect(
    page.locator(`[data-pdf-comment-id="${commentId}"]`).first(),
  ).toBeVisible();
  console.log("Highlight survived page revisit and recompilation");
  const comments = await page.evaluate(async (project) => {
    const reply = await window.catalex.invoke(
      "read_project_comments_anchored",
      { projectRoot: project },
    );
    if (reply.error) throw new Error(JSON.stringify(reply.error));
    return reply.result;
  }, project);
  assert(
    JSON.stringify(comments).includes("Range loading preserves this comment"),
  );
  const saved = Object.values(comments.files)
    .flat()
    .find((comment) => comment.id === commentId);
  assert(saved, "Comment stays in the native store");
  const source = await fs.readFile(mainFile, "utf8");
  assert.equal(source.slice(saved.from, saved.to), "Unique range selection");
  await page
    .locator(`[data-pdf-comment-id="${commentId}"]`)
    .first()
    .scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: path.join(output, "comment-after-recompile.png"),
  });
  // Native export must copy the immutable snapshot without pulling its bytes into React.
  const snapshot = await page.evaluate(async (project) => {
    const reply = await window.catalex.invoke("compile_latex_snapshot", {
      projectDir: project,
      mainFile: "main.tex",
      backend: "latexmk",
      engine: "pdflatex",
      diagnostics: { __channel: 999999 },
      installation: null,
    });
    if (reply.error) throw new Error(JSON.stringify(reply.error));
    return reply.result;
  }, project);
  assert.equal(snapshot.kind, "file");
  const exportPath = path.join(project, "export.pdf");
  const exported = await page.evaluate(
    async ({ id, path }) =>
      window.catalex.invoke("desktop:pdf:export", { id, path }),
    { id: snapshot.id, path: exportPath },
  );
  assert(!exported.error, JSON.stringify(exported));
  assert.equal((await fs.stat(exportPath)).size, snapshot.byteLength);
  assert.equal(
    await digest(exportPath),
    await digest(path.join(profile, "pdf-snapshots", `${snapshot.id}.pdf`)),
  );
  await page.evaluate(
    async (id) => window.catalex.invoke("desktop:pdf:release", { id }),
    snapshot.id,
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        initialBytes,
        pdfBytes: Math.max(...sizes),
        initialRequests: reads.length,
        commentId,
        commentsSurvived: true,
        exportBytes: snapshot.byteLength,
        errors,
      },
      null,
      2,
    ),
  );
  // Reload releases all snapshots and worker leases belonging to the old renderer.
  const oldFiles = await fs.readdir(path.join(profile, "pdf-snapshots"));
  await page.reload();
  await expect
    .poll(async () => {
      const current = await fs.readdir(path.join(profile, "pdf-snapshots"));
      return oldFiles.filter((name) => current.includes(name));
    })
    .toEqual([]);
  console.log("PDF range/comment/recompile/export smoke passed");
} catch (error) {
  await (await app.firstWindow())
    .screenshot({ path: path.join(output, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  // Native close confirmation can keep this isolated test process alive.
  let closeTimer;
  try {
    await Promise.race([
      app.close(),
      new Promise((resolve) => {
        closeTimer = setTimeout(() => {
          app.process().kill("SIGKILL");
          resolve();
        }, 5000);
      }),
    ]);
  } finally {
    clearTimeout(closeTimer);
  }
  await fs.rm(profile, { recursive: true, force: true });
}
