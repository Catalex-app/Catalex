// Opt-in measurements against the built production renderer in actual Electron.
// Generate fixtures with ../pdf-performance-fixture.py before running this file.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const output = path.resolve(
  desktopRoot,
  "../../output/playwright/pdf-performance",
);
const cases = (
  process.env.CATALEX_PDF_PERF_CASES ?? "100p-2k,300p-2k,100p-4k"
).split(",");
const results = [];
const hardware = {
  platform: os.platform(),
  release: os.release(),
  arch: os.arch(),
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  ramGiB: os.totalmem() / 2 ** 30,
};
const runName = process.env.CATALEX_PDF_PERF_RUN ?? "current";
await fs.mkdir(output, { recursive: true });

for (const name of cases) {
  const project = path.join(output, "fixtures", name);
  const fixture = JSON.parse(
    await fs.readFile(path.join(project, "fixture.json"), "utf8"),
  );
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), "catalex-pdf-performance-"),
  );
  const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CATALEX_DEV_URL;
  const app = await electron.launch({
    args: [desktopRoot],
    env,
    timeout: 30_000,
  });
  const result = { fixture, phases: [], memory: [], errors: [] };
  results.push(result);
  const sampleMemory = async (phase, page, cdp) => {
    const processes = await app.evaluate(({ app }) =>
      app.getAppMetrics().map((p) => ({
        type: p.type,
        workingSetMiB: p.memory.workingSetSize / 1024,
      })),
    );
    const heap = await cdp.send("Runtime.getHeapUsage");
    const pixels = await page.evaluate(() => {
      const canvases = [...document.querySelectorAll(".mupdf-page canvas")];
      return {
        canvasMiB:
          canvases.reduce((sum, c) => sum + c.width * c.height * 4, 0) /
          2 ** 20,
        allocatedCanvases: canvases.filter((c) => c.width > 0).length,
        mountedPages: document.querySelectorAll(".mupdf-page").length,
      };
    });
    result.memory.push({
      phase,
      processes,
      jsHeapMiB: heap.usedSize / 2 ** 20,
      backingStorageMiB: heap.backingStorageSize / 2 ** 20,
      ...pixels,
    });
  };
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(60_000);
    page.on("pageerror", (error) => result.errors.push(error.message));
    const window = await app.browserWindow(page);
    await window.evaluate((window) => {
      window.unmaximize();
      window.setSize(1440, 1000);
      window.show();
      window.focus();
    });
    await page.waitForFunction(
      () => window.catalex && document.querySelector("#root")?.children.length,
    );
    // Reloading before the host's initial loadURL resolves aborts app startup.
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
          state.phase.longTasks.push(
            ...list.getEntries().map((e) => e.duration),
          );
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
            width: document
              .querySelector(".mupdf-page")
              ?.getBoundingClientRect().width,
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
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    await app.evaluate(({ dialog }, project) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [project],
      });
    }, project);
    await page.getByTestId("welcome-new-project-menu-trigger").click();
    await page.getByRole("menuitem", { name: "Open Folder" }).click();
    await page.locator(".cm-content").first().waitFor();
    // The welcome window can finish restoring maximization after firstWindow.
    // Set benchmark geometry only after the workspace is ready.
    await window.evaluate((window) => {
      window.unmaximize();
      window.setSize(1440, 1000);
    });
    await page.waitForFunction(() => innerWidth === 1440);
    console.log(`${runName} ${name}: project opened`);
    const cdp = await page.context().newCDPSession(page);
    result.runtime = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      dpr: devicePixelRatio,
      width: innerWidth,
      height: innerHeight,
    }));
    result.graphics = await app.evaluate(({ app }) =>
      app.getGPUFeatureStatus(),
    );
    await sampleMemory("before-open", page, cdp);
    await page.evaluate(() => window.__pdfPerf.start("open"));
    await page.getByText("figures.pdf", { exact: true }).first().click();
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector("[data-pdf-page-canvas]");
        return canvas?.dataset.pdfRenderedScale && canvas.width > 0;
      },
      undefined,
      { timeout: 120_000 },
    );
    result.phases.push(await page.evaluate(() => window.__pdfPerf.stop()));
    await page.waitForTimeout(700);
    assert.equal(await page.locator(".mupdf-page").count(), fixture.pages);
    await sampleMemory("opened", page, cdp);
    const zoom = page.getByRole("textbox", { name: "Zoom percentage" });
    const firstCanvas = page.locator(
      '[data-page-number="1"] [data-pdf-page-canvas]',
    );
    const setZoom = async (value) => {
      await zoom.fill(String(value));
      await zoom.press("Enter");
      await page.waitForFunction(
        (scale) =>
          Math.abs(
            Number(
              document.querySelector(
                '[data-page-number="1"] [data-pdf-page-canvas]',
              )?.dataset.pdfRenderedScale,
            ) - scale,
          ) < 0.001,
        value / 100,
      );
      await page.waitForTimeout(250);
    };
    for (let repeat = 1; repeat <= 3; repeat++) {
      await setZoom(100);
      await page.evaluate(async () => {
        window.__pdfPerf.start("zoom-six-clicks");
        for (let n = 0; n < 6; n++) {
          window.__pdfLastInput = performance.now();
          document.querySelector('[aria-label="Zoom in"]').click();
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      });
      await page.waitForFunction(
        () =>
          Math.abs(
            Number(
              document.querySelector(
                '[data-page-number="1"] [data-pdf-page-canvas]',
              )?.dataset.pdfRenderedScale,
            ) - 1.6,
          ) < 0.001,
      );
      result.phases.push(
        await page.evaluate(() => ({
          ...window.__pdfPerf.stop(),
          sharpAfterLastInputMs: performance.now() - window.__pdfLastInput,
        })),
      );
    }
    await page.screenshot({
      path: path.join(output, `${runName}-${name}-zoom.png`),
    });
    for (const value of [400, 1200]) {
      await page.evaluate(
        (value) => window.__pdfPerf.start(`zoom-${value}`),
        value,
      );
      await zoom.fill(String(value));
      await zoom.press("Enter");
      await page.waitForFunction((value) => {
        const paper = document.querySelector('[data-page-number="1"]');
        const detail = paper.querySelector("[data-pdf-detail-canvas]");
        return (
          detail?.width > 0 &&
          Number(detail.dataset.pdfRenderedScale) ===
            (value / 100) * devicePixelRatio
        );
      }, value);
      result.phases.push(await page.evaluate(() => window.__pdfPerf.stop()));
      await sampleMemory(`zoom-${value}`, page, cdp);
    }
    // Move into the actual image, rather than measuring only the page heading.
    await page.evaluate(() => window.__pdfPerf.start("pan-1200-figure"));
    for (const [x, y] of [
      [120, 180],
      [160, 230],
      [90, 280],
    ]) {
      const before = await page.evaluate(
        ([x, y]) => {
          const before = window.__pdfPerf.completedDetails();
          const el = document.querySelector(
            '[data-testid="pdf-scroll-container"]',
          );
          const paper = document.querySelector('[data-page-number="1"]');
          const bounds = paper.getBoundingClientRect();
          const viewport = el.getBoundingClientRect();
          el.scrollLeft +=
            bounds.left - viewport.left + (x / 612) * bounds.width;
          el.scrollTop += bounds.top - viewport.top + (y / 792) * bounds.height;
          return before;
        },
        [x, y],
      );
      await page.waitForFunction(
        (before) => window.__pdfPerf.completedDetails() > before,
        before,
      );
      await page.waitForTimeout(50);
    }
    result.phases.push(await page.evaluate(() => window.__pdfPerf.stop()));
    await sampleMemory("panned-1200", page, cdp);
    await page.screenshot({
      path: path.join(output, `${runName}-${name}-1200.png`),
    });
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="pdf-scroll-container"]');
      el.scrollTo({ top: 0, left: 0, behavior: "instant" });
    });
    await setZoom(100);
    await page.evaluate(async () => {
      window.__pdfPerf.start("pinch");
      const el = document.querySelector('[data-testid="pdf-scroll-container"]');
      const b = el.getBoundingClientRect();
      for (let n = 0; n < 12; n++) {
        el.dispatchEvent(
          new WheelEvent("wheel", {
            ctrlKey: true,
            deltaY: -5,
            clientX: b.left + 200,
            clientY: b.top + 300,
            bubbles: true,
            cancelable: true,
          }),
        );
        await new Promise(requestAnimationFrame);
      }
    });
    await page.waitForTimeout(800);
    result.phases.push(await page.evaluate(() => window.__pdfPerf.stop()));
    await page.getByRole("button", { name: "Fit width", exact: true }).click();
    await page.waitForTimeout(700);
    await page.evaluate(() => window.__pdfPerf.start("window-resize"));
    for (const width of [1200, 1000, 1440, 1100, 1440]) {
      await window.evaluate(
        (window, width) => window.setSize(width, 1000),
        width,
      );
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(700);
    result.phases.push(await page.evaluate(() => window.__pdfPerf.stop()));
    await setZoom(100);
    await page.evaluate(async () => {
      const el = document.querySelector('[data-testid="pdf-scroll-container"]');
      window.__pdfPerf.start("continuous-scroll");
      const start = performance.now();
      await new Promise((resolve) => {
        const scroll = () => {
          el.scrollTop = (performance.now() - start) * 6;
          if (performance.now() - start < 5000) requestAnimationFrame(scroll);
          else resolve();
        };
        requestAnimationFrame(scroll);
      });
    });
    result.phases.push(await page.evaluate(() => window.__pdfPerf.stop()));
    const visits = [];
    for (let n = 1; n <= fixture.pages; n++) {
      const start = performance.now();
      await page
        .locator(`[data-page-number="${n}"]`)
        .evaluate((el) =>
          el.scrollIntoView({ block: "center", behavior: "instant" }),
        );
      await page.waitForFunction((n) => {
        const canvas = document.querySelector(
          `[data-page-number="${n}"] [data-pdf-page-canvas]`,
        );
        return canvas?.width > 0 && canvas.dataset.pdfRenderedScale;
      }, n);
      visits.push(performance.now() - start);
      if (n % 25 === 0)
        console.log(`${runName} ${name}: visited ${n}/${fixture.pages}`);
    }
    const sorted = [...visits].sort((a, b) => a - b);
    result.pageVisits = {
      count: visits.length,
      p50Ms: sorted[Math.floor(sorted.length * 0.5)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      maxMs: Math.max(...visits),
    };
    await sampleMemory("all-pages-visited", page, cdp);
    await page.screenshot({
      path: path.join(output, `${runName}-${name}-last-page.png`),
    });
    await page
      .locator('[data-page-number="1"]')
      .evaluate((el) =>
        el.scrollIntoView({ block: "start", behavior: "instant" }),
      );
    await firstCanvas.waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-page-number="1"] [data-pdf-page-canvas]')
          ?.width > 0,
    );
    await sampleMemory("returned-to-first", page, cdp);
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
    await sampleMemory("after-forced-gc", page, cdp);
    assert.deepEqual(result.errors, []);
    console.log(
      JSON.stringify({
        run: runName,
        fixture,
        phases: result.phases,
        memory: result.memory,
        pageVisits: result.pageVisits,
      }),
    );
  } catch (error) {
    result.failure = String(error.stack ?? error);
    console.error(`${name}: ${result.failure}`);
    try {
      await (await app.firstWindow()).screenshot({
        path: path.join(output, `${runName}-${name}-failure.png`),
      });
    } catch {}
  } finally {
    await fs.writeFile(
      path.join(output, `${runName}-results.json`),
      `${JSON.stringify({ hardware, run: runName, results }, null, 2)}\n`,
    );
    await app.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
}
if (results.some((r) => r.failure)) process.exitCode = 1;
