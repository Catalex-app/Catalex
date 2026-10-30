// Opt-in compiled-preview diagnostic. Run from the repository root; see docs/testing/pdf-performance.md.
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const require = createRequire(`${process.cwd()}/package.json`);
const { _electron: electron } = require("@playwright/test");
const run = process.env.PDF_DIAG_RUN ?? "dev-baseline";
const production = process.env.PDF_DIAG_PRODUCTION === "1";
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-layout-diag-"),
);
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CATALEX_DEV_URL: process.env.PDF_DIAG_DEV_URL ?? "http://127.0.0.1:4173",
};
delete env.ELECTRON_RUN_AS_NODE;
if (production) delete env.CATALEX_DEV_URL;
const app = await electron.launch({
  executablePath: process.env.PDF_DIAG_EXECUTABLE,
  args: process.env.PDF_DIAG_EXECUTABLE ? [] : [path.resolve("apps/desktop")],
  env,
  timeout: 30000,
});
const results = [];
const errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(60000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.waitForLoadState("load");
  console.log("initial navigation finished");
  await page.evaluate(() =>
    localStorage.setItem(
      "catalex-onboarding",
      JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
    ),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [project],
    });
  }, path.resolve("output/playwright/pdf-switch-diagnostic/project"));
  await page.getByTestId("welcome-new-project-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Open Folder" }).click();
  await page.locator(".cm-content").first().waitFor();
  const win = await app.browserWindow(page);
  await win.evaluate((w) => {
    w.unmaximize();
    w.setSize(1440, 1000);
  });
  console.log("project opened");

  await page
    .getByRole("button", { name: /Recompile/ })
    .first()
    .click();
  await page
    .locator("[data-pdf-page-canvas]")
    .first()
    .waitFor({ timeout: 120000 });
  await page.waitForFunction(
    () => document.querySelector("[data-pdf-page-canvas]")?.width > 0,
    undefined,
    { timeout: 120000 },
  );
  await page.waitForTimeout(2000);
  if ((await page.locator(".mupdf-page").count()) !== 16)
    throw new Error("Expected the 16-page compiled fixture");
  const disableSync = page.getByRole("button", {
    name: "Disable synchronized scrolling",
    exact: true,
  });
  if (await disableSync.count()) await disableSync.click();
  if (
    (await page
      .getByRole("button", {
        name: "Enable synchronized scrolling",
        exact: true,
      })
      .getAttribute("aria-pressed")) !== "false"
  )
    throw new Error("Synchronized scrolling must be disabled");
  console.log(
    "sync controls",
    await page
      .locator('[aria-label*="ync"],[title*="ync"]')
      .evaluateAll((els) =>
        els.map((e) => ({
          text: e.textContent,
          label: e.getAttribute("aria-label"),
          title: e.getAttribute("title"),
          pressed: e.getAttribute("aria-pressed"),
        })),
      ),
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  if (process.env.PDF_DIAG_PROFILE) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    globalThis.profileBase = await page.evaluate(() => performance.now());
  }
  await page.evaluate(() => {
    window.__reads = [];
    const read = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      const start = performance.now();
      try {
        return read.apply(this, args);
      } finally {
        window.__reads.push({
          start,
          ms: performance.now() - start,
          width: this.canvas.width,
          height: this.canvas.height,
          page: this.canvas.closest("[data-page-number]")?.dataset.pageNumber,
          moving: document.querySelector("[data-workspace-layout-animating]")
            ?.dataset.workspaceLayoutAnimating,
        });
      }
    };
  });
  for (let i = 0; i < Number(process.env.PDF_DIAG_CYCLES ?? 20); i++) {
    if (process.env.PDF_DIAG_SELECT && i === 4) {
      // Ordinary page interaction must not permanently disable text virtualization.
      await page
        .locator(".mupdf-text-layer")
        .first()
        .click({
          position: { x: 50, y: 50 },
        });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(1500);
    }
    // Keep the first four switches cold, then exercise zoom and fit before
    // each transition. Separate zoom-only/switch-only runs miss this sequence.
    if (process.env.PDF_DIAG_ZOOM && i >= 4) {
      const zoom = page.getByRole("textbox", { name: "Zoom percentage" });
      await zoom.fill(i % 2 ? "1200" : "400");
      await zoom.press("Enter");
      await page.waitForTimeout(900);
      if (process.env.PDF_DIAG_ZOOM !== "manual") {
        await page
          .getByRole("button", { name: "Fit width", exact: true })
          .click();
        await page.waitForTimeout(900);
      }
    }
    if (i === 4 || i === 12) {
      await page
        .locator(`[data-page-number="${i === 4 ? 8 : 14}"]`)
        .evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(2000);
    }
    if (process.env.PDF_DIAG_CLEAR_MEASURES)
      await page.evaluate(() => performance.clearMeasures());
    const before = Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
        m.name,
        m.value,
      ]),
    );
    const r = await page.evaluate(async (i) => {
      const frames = [];
      window.__reads = [];
      let last = performance.now();
      const start = last;
      let active = true;
      const tick = () => {
        const now = performance.now();
        frames.push({
          elapsed: now - start,
          dt: now - last,
          moving: document.querySelector("[data-workspace-layout-animating]")
            ?.dataset.workspaceLayoutAnimating,
        });
        last = now;
        if (active) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      [
        ...document
          .querySelector('[aria-label="Workspace view mode"]')
          .querySelectorAll('[role="tab"]'),
      ]
        .find(
          (e) =>
            e.getAttribute("aria-label") === (i % 2 === 0 ? "PDF" : "Split"),
        )
        .click();
      await new Promise((r) => setTimeout(r, 1000));
      active = false;
      const canvases = [...document.querySelectorAll("[data-pdf-page-canvas]")];
      return {
        i,
        start,
        measures: performance.getEntriesByType("measure").length,
        frames,
        reads: window.__reads,
        nodes: document.querySelectorAll("*").length,
        textLayers: document.querySelectorAll(".mupdf-text-layer").length,
        canvasMiB:
          canvases.reduce((n, c) => n + c.width * c.height * 4, 0) / 2 ** 20,
        allocated: canvases.filter((c) => c.width > 0).length,
      };
    }, i);
    const after = Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
        m.name,
        m.value,
      ]),
    );
    for (const key of [
      "LayoutDuration",
      "RecalcStyleDuration",
      "ScriptDuration",
      "TaskDuration",
    ])
      r[`${key}Ms`] = (after[key] - before[key]) * 1000;
    r.heapMiB = after.JSHeapUsedSize / 2 ** 20;
    r.listeners = after.JSEventListeners;
    r.layoutCount = after.LayoutCount - before.LayoutCount;
    r.processes = await app.evaluate(({ app }) =>
      app.getAppMetrics().map((process) => ({
        type: process.type,
        workingSetMiB: process.memory.workingSetSize / 1024,
      })),
    );
    results.push(r);
    console.log(
      JSON.stringify({
        ...r,
        frames: undefined,
        maxFrame: Math.max(...r.frames.map((f) => f.dt)),
        movingFrames: r.frames
          .filter((f) => f.moving === "true")
          .map((f) => Math.round(f.dt)),
      }),
    );
  }
  if (process.env.PDF_DIAG_PROFILE) {
    const { profile } = await cdp.send("Profiler.stop");
    await fs.writeFile(
      `output/playwright/pdf-switch-diagnostic/${run}-cpu.json`,
      JSON.stringify({ ...profile, baseNow: globalThis.profileBase }),
    );
  }
  await page.screenshot({
    path: `output/playwright/pdf-switch-diagnostic/${run}.png`,
  });
  if (errors.length) throw new Error(errors.join("\n"));
} catch (e) {
  console.error(e);
  await (await app.firstWindow()).screenshot({
    path: "output/playwright/pdf-switch-diagnostic/error.png",
  });
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    `output/playwright/pdf-switch-diagnostic/${run}.json`,
    JSON.stringify(results, null, 2),
  );
  await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
