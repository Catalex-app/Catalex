// Repeated zoom/Fit Width diagnostic for a compiled, figure-heavy LaTeX preview.
// Generate the --latex fixture first; build the desktop host before running.
// Set CATALEX_DEV_URL for Vite, or omit it to use the built production renderer.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "@playwright/test";
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-pdf-zoom-"));
const project = path.join(profile, "paper");
const output = path.resolve("output/playwright/pdf-zoom");
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
if (!process.env.CATALEX_DEV_URL) delete env.CATALEX_DEV_URL;
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
  await page.addInitScript(() => {
    const state = { phase: null, workerJobs: [] };
    const seen = new WeakSet();
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, options) {
      if (Array.isArray(message)) {
        if (!seen.has(this)) {
          seen.add(this);
          this.addEventListener("message", (event) => {
            const job = state.workerJobs.findLast(
              (job) => job.id === event.data?.[1] && job.end === undefined,
            );
            if (job) job.end = performance.now();
          });
        }
        state.workerJobs.push({
          method: message[0],
          id: message[1],
          page: message[2]?.[1],
          dpi: message[2]?.[2],
          start: performance.now(),
        });
      }
      return post.call(this, message, options);
    };
    new PerformanceObserver((list) => {
      if (state.phase)
        state.phase.longTasks.push(...list.getEntries().map((e) => e.duration));
    }).observe({ type: "longtask", buffered: false });
    const quantile = (xs, q) =>
      [...xs].sort((a, b) => a - b)[
        Math.min(xs.length - 1, Math.floor(xs.length * q))
      ] ?? 0;
    window.__pdfPerf = {
      completedDetails() {
        return state.workerJobs.filter(
          (job) => job.method === "drawPageRegion" && job.end,
        ).length;
      },
      start(label) {
        const now = performance.now();
        const phase = {
          label,
          start: now,
          lastFrame: now,
          frames: [],
          longTasks: [],
          firstResponseMs: null,
          width: document.querySelector(".mupdf-page")?.getBoundingClientRect()
            .width,
        };
        state.phase = phase;
        const frame = (time) => {
          if (state.phase !== phase) return;
          phase.frames.push(time - phase.lastFrame);
          phase.lastFrame = time;
          const width = document
            .querySelector(".mupdf-page")
            ?.getBoundingClientRect().width;
          if (
            phase.firstResponseMs === null &&
            Math.abs(width - phase.width) > 0.1
          )
            phase.firstResponseMs = time - phase.start;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      },
      stop() {
        const phase = state.phase;
        state.phase = null;
        const jobs = state.workerJobs.filter((j) => j.start >= phase.start);
        return {
          label: phase.label,
          durationMs: performance.now() - phase.start,
          firstResponseMs: phase.firstResponseMs,
          frameCount: phase.frames.length,
          frameP50Ms: quantile(phase.frames, 0.5),
          frameP95Ms: quantile(phase.frames, 0.95),
          frameMaxMs: Math.max(0, ...phase.frames),
          framesOver33Ms: phase.frames.filter((n) => n > 33.4).length,
          longTasks: phase.longTasks,
          baseRenders: jobs.filter((j) => j.method === "drawPage").length,
          detailRenders: jobs.filter((j) => j.method === "drawPageRegion")
            .length,
          renderDpis: [
            ...new Set(
              jobs.filter((j) => j.method === "drawPage").map((j) => j.dpi),
            ),
          ],
          workerP95Ms: quantile(
            jobs
              .filter((j) => j.method === "drawPage" && j.end)
              .map((j) => j.end - j.start),
            0.95,
          ),
          detailWorkerP95Ms: quantile(
            jobs
              .filter((j) => j.method === "drawPageRegion" && j.end)
              .map((j) => j.end - j.start),
            0.95,
          ),
        };
      },
    };
  });

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

  await page.waitForFunction(
    () => document.querySelector("[data-pdf-page-canvas]")?.width > 0,
  );
  await page.getByRole("tab", { name: "PDF", exact: true }).click();
  await page.waitForTimeout(700);
  await page
    .locator('[data-page-number="8"]')
    .evaluate((el) =>
      el.scrollIntoView({ block: "center", behavior: "instant" }),
    );
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  const results = [];
  const clickMode = process.env.CATALEX_ZOOM_INPUT === "buttons";
  const cycles = clickMode ? 60 : 30;
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.enable");
  for (let cycle = 0; cycle < cycles; cycle++) {
    const profileCycle = clickMode && (cycle < 3 || cycle >= cycles - 3);
    if (profileCycle) await cdp.send("Profiler.start");
    const metricsBefore = await cdp.send("Performance.getMetrics");
    await page.evaluate(
      (cycle) => window.__pdfPerf.start(`cycle-${cycle}`),
      cycle,
    );
    const zoom = page.getByRole("textbox", { name: "Zoom percentage" });
    if (clickMode) {
      await page.evaluate(async () => {
        for (let i = 0; i < 6; i++) {
          document.querySelector('[aria-label="Zoom in"]').click();
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      });
      await page.waitForTimeout(300);
    } else {
      await zoom.fill(cycle % 2 ? "1200" : "400");
      await zoom.press("Enter");
      await page.waitForTimeout(900);
    }
    await page.getByRole("button", { name: "Fit width", exact: true }).click();
    await page.waitForTimeout(clickMode ? 500 : 900);
    const timing = await page.evaluate(() => window.__pdfPerf.stop());
    const heap = await cdp.send("Runtime.getHeapUsage");
    const processes = await app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .map((p) => ({ type: p.type, MiB: p.memory.workingSetSize / 1024 })),
    );
    const pixels = await page.evaluate(
      () =>
        [...document.querySelectorAll("canvas")].reduce(
          (n, c) => n + c.width * c.height * 4,
          0,
        ) /
        2 ** 20,
    );
    const metricsAfter = await cdp.send("Performance.getMetrics");
    const before = Object.fromEntries(
      metricsBefore.metrics.map((m) => [m.name, m.value]),
    );
    const durations = Object.fromEntries(
      metricsAfter.metrics
        .filter((m) => m.name.endsWith("Duration"))
        .map((m) => [m.name, (m.value - before[m.name]) * 1000]),
    );
    const dom = await cdp.send("Memory.getDOMCounters");
    if (profileCycle) {
      const { profile } = await cdp.send("Profiler.stop");
      await fs.writeFile(
        path.join(
          output,
          `${process.env.CATALEX_ZOOM_RUN ?? "current"}-${cycle}.cpuprofile`,
        ),
        JSON.stringify(profile),
      );
    }
    results.push({ cycle, timing, heap, processes, pixels, durations, dom });
    console.log(JSON.stringify(results.at(-1)));
    await fs.writeFile(
      path.join(output, `${process.env.CATALEX_ZOOM_RUN ?? "current"}.json`),
      JSON.stringify(results, null, 2),
    );
  }
  await page.screenshot({
    path: path.join(
      output,
      `${process.env.CATALEX_ZOOM_RUN ?? "current"}-fit.png`,
    ),
  });
  const zoom = page.getByRole("textbox", { name: "Zoom percentage" });
  await zoom.fill("400");
  await zoom.press("Enter");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("[data-pdf-detail-canvas]")].some(
      (c) =>
        c.width > 0 &&
        Number(c.dataset.pdfRenderedScale) === 4 * devicePixelRatio,
    ),
  );
  const basePixels = await page
    .locator("[data-pdf-page-canvas]")
    .evaluateAll((cs) => Math.max(...cs.map((c) => c.width * c.height)));
  assert(
    basePixels <= 8 * 1024 * 1024 + 16384,
    "Base page rasters must stay bounded (including pixel rounding)",
  );
  await page.screenshot({
    path: path.join(
      output,
      `${process.env.CATALEX_ZOOM_RUN ?? "current"}-detail.png`,
    ),
  });
  assert.deepEqual(errors, []);
} finally {
  const child = app.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }
  await fs.rm(profile, { recursive: true, force: true });
}
