// Opt-in real-project benchmark. Download fixtures into temporary storage per run.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const desktop = fileURLToPath(new URL("../..", import.meta.url));
const root = path.resolve(desktop, "../..");
const output = path.join(root, "output/playwright/long-paper");
const run = process.env.CATALEX_LONG_PAPER_RUN ?? "current";
assert.match(run, /^[a-zA-Z0-9_-]+$/);
const cases = (
  process.env.CATALEX_LONG_PAPER_CASES ?? "higher-topos,string-theory"
).split(",");
const cycles = Number(process.env.CATALEX_LONG_PAPER_CYCLES ?? 20);
assert(Number.isInteger(cycles) && cycles >= 2 && cycles <= 200);
const results = {
  timestamp: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  version: JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  ).version,
  hardware: {
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    ramGiB: os.totalmem() / 2 ** 30,
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
  },
  executable:
    process.env.CATALEX_LONG_PAPER_EXECUTABLE ??
    "Electron host with production renderer",
  cycles,
  cases: [],
};
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
};
await fs.mkdir(output, { recursive: true });

const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-long-paper-"),
);
try {
  execFileSync(
    "python3",
    [path.join(desktop, "e2e/long-paper-fixture.py"), temporary],
    {
      stdio: "inherit",
    },
  );
  for (const name of cases) {
    assert(["higher-topos", "string-theory"].includes(name));
    const fixtureRoot = path.join(temporary, "fixtures", name);
    const fixture = JSON.parse(
      await fs.readFile(path.join(fixtureRoot, "fixture.json"), "utf8"),
    );
    const profile = await fs.mkdtemp(path.join(temporary, "profile-"));
    const project = path.join(profile, name);
    await fs.mkdir(project);
    // Copy only the verified original submission files, never prior build artifacts.
    for (const [file, metadata] of Object.entries(fixture.files)) {
      const bytes = await fs.readFile(path.join(fixtureRoot, file));
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        metadata.sha256,
        file,
      );
      await fs.mkdir(path.dirname(path.join(project, file)), {
        recursive: true,
      });
      await fs.writeFile(path.join(project, file), bytes);
    }
    const result = {
      name,
      fixture,
      profile,
      phases: [],
      memory: [],
      errors: [],
    };
    results.cases.push(result);
    const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CATALEX_DEV_URL;
    const app = await electron.launch({
      ...(process.env.CATALEX_LONG_PAPER_EXECUTABLE
        ? {
            executablePath: process.env.CATALEX_LONG_PAPER_EXECUTABLE,
            args: [],
          }
        : { args: [desktop] }),
      env,
      timeout: 30_000,
    });
    let page;
    try {
      page = await app.firstWindow();
      page.setDefaultTimeout(60_000);
      page.on("pageerror", (error) => result.errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error")
          console.log(`${name} renderer: ${message.text().slice(0, 800)}`);
      });
      await page.waitForFunction(
        () =>
          window.catalex && document.querySelector("#root")?.children.length,
      );
      await page.waitForLoadState("load");
      await page.evaluate((engine) => {
        localStorage.setItem(
          "catalex-onboarding",
          JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
        );
        const settings = JSON.parse(
          localStorage.getItem("catalex-settings") ?? "{}",
        );
        settings.state = {
          ...settings.state,
          defaultAutoCompile: false,
          compilerBackend: "latexmk",
          compilerEngine: engine,
        };
        localStorage.setItem("catalex-settings", JSON.stringify(settings));
      }, fixture.engine);
      await page.addInitScript(() => {
        let phase;
        new PerformanceObserver((list) => {
          if (phase)
            phase.longTasks.push(
              ...list
                .getEntries()
                .filter((e) => e.startTime >= phase.start)
                .map((e) => e.duration),
            );
        }).observe({ type: "longtask" });
        document.addEventListener(
          "keydown",
          (event) => {
            if (!phase) return;
            if (!event.target.closest?.(".cm-content")) {
              phase.nonEditorKeys.push({
                key: event.key,
                target: event.target.className,
              });
              return;
            }
            const current = phase;
            const start = performance.now();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                current.keyToTwoFramesMs.push(performance.now() - start);
              }),
            );
          },
          true,
        );
        window.__longPaper = {
          start(label) {
            phase = {
              label,
              start: performance.now(),
              frames: [],
              longTasks: [],
              keyToTwoFramesMs: [],
              nonEditorKeys: [],
            };
            const current = phase;
            let last = current.start;
            const tick = () => {
              if (phase !== current) return;
              const now = performance.now();
              current.frames.push(now - last);
              last = now;
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          },
          stop() {
            const current = phase;
            phase = undefined;
            return { ...current, elapsedMs: performance.now() - current.start };
          },
        };
      });
      await page.reload();
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      const win = await app.browserWindow(page);
      await win.evaluate((window) => {
        window.unmaximize();
        window.setSize(1440, 1000);
        window.show();
        window.focus();
      });
      result.runtime = await app.evaluate(() => process.versions);
      await app.evaluate(({ ipcMain }) => {
        const original = ipcMain._invokeHandlers.get("desktop:invoke");
        globalThis.__longPaperNative = {};
        ipcMain.removeHandler("desktop:invoke");
        ipcMain.handle("desktop:invoke", async (event, command, args) => {
          const stats = (globalThis.__longPaperNative[command] ??= {
            calls: 0,
            pending: 0,
            maxPending: 0,
            totalMs: 0,
          });
          stats.calls++;
          stats.pending++;
          stats.maxPending = Math.max(stats.maxPending, stats.pending);
          const start = performance.now();
          try {
            const reply = await original(event, command, args);
            if (reply?.error) stats.failures = (stats.failures ?? 0) + 1;
            if (
              command === "synctex_edit" &&
              reply?.result?.line > 0 &&
              reply.result.file
            )
              stats.sourceResults = (stats.sourceResults ?? 0) + 1;
            return reply;
          } finally {
            stats.pending--;
            stats.totalMs += performance.now() - start;
          }
        });
      });
      result.viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }));
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      const sample = async (label, gc = false) => {
        if (gc) await cdp.send("HeapProfiler.collectGarbage");
        const processes = await app.evaluate(({ app }) =>
          app.getAppMetrics().map((p) => ({
            type: p.type,
            pid: p.pid,
            workingSetMiB: p.memory.workingSetSize / 1024,
          })),
        );
        const mainPid = app.process().pid;
        const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .map((row) => {
            const match = row.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
            return (
              match && {
                pid: +match[1],
                parent: +match[2],
                rssMiB: +match[3] / 1024,
                command: match[4],
              }
            );
          })
          .filter(Boolean);
        const descendants = new Set([mainPid]);
        for (let pass = 0; pass < rows.length; pass++) {
          const count = descendants.size;
          for (const row of rows)
            if (descendants.has(row.parent)) descendants.add(row.pid);
          if (count === descendants.size) break;
        }
        result.memory.push({
          label,
          gc,
          ipc: await app.evaluate(() => globalThis.__longPaperNative),
          processes,
          workers: page.workers().map((worker) => worker.url()),
          native: rows.filter(
            (p) => descendants.has(p.pid) && /catalex-desktop/.test(p.command),
          ),
          heap: await cdp.send("Runtime.getHeapUsage"),
          dom: await cdp.send("Memory.getDOMCounters"),
          ui: await page.evaluate(() => ({
            nodes: document.querySelectorAll("*").length,
            pdfPages: document.querySelectorAll(".mupdf-page").length,
            canvasMiB:
              [...document.querySelectorAll(".mupdf-page canvas")].reduce(
                (n, c) => n + c.width * c.height * 4,
                0,
              ) /
              2 ** 20,
          })),
        });
      };
      const phase = async (label, action) => {
        const profiling =
          (process.env.CATALEX_LONG_PAPER_PROFILE === "1" &&
            label === "typing") ||
          (process.env.CATALEX_LONG_PAPER_PROFILE === "views" &&
            label.startsWith("view-"));
        if (profiling) {
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.start");
        }
        await page.evaluate((label) => window.__longPaper.start(label), label);
        const start = performance.now();
        await action();
        const actionMs = performance.now() - start;
        await page.waitForTimeout(100);
        const value = await page.evaluate(() => window.__longPaper.stop());
        Object.assign(value, {
          actionMs,
          frameSummary: summary(value.frames),
          keySummary: summary(value.keyToTwoFramesMs),
        });
        result.phases.push(value);
        if (profiling) {
          const { profile } = await cdp.send("Profiler.stop");
          await fs.writeFile(
            path.join(output, `${run}-${name}-${label}.cpuprofile`),
            JSON.stringify(profile),
          );
        }
        console.log(
          JSON.stringify({
            case: name,
            phase: label,
            actionMs,
            frames: value.frameSummary,
            keys: value.keySummary,
            longTasks: value.longTasks,
          }),
        );
      };
      await sample("welcome", true);
      await app.evaluate(({ dialog }, project) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [project],
        });
      }, project);
      await page.getByTestId("welcome-new-project-menu-trigger").click();
      await phase("open-project", async () => {
        await page.getByRole("menuitem", { name: "Open Folder" }).click();
        await page.locator(".cm-content").first().waitFor();
      });
      await page.waitForTimeout(1500);
      await sample("opened");
      console.log(`${name}: project opened`);
      await page
        .locator(`[data-sidebar-file-id="${encodeURIComponent(fixture.main)}"]`)
        .first()
        .click();
      const compile = page.getByRole("button", {
        name: "Recompile",
        exact: true,
      });
      await phase("cold-compile", async () => {
        await compile.click();
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll("h2")].some(
              (el) => el.textContent === "Compilation Failed",
            ) ||
            (document.querySelectorAll(".mupdf-page").length >= 200 &&
              document.querySelector("[data-pdf-page-canvas]")?.width > 0),
          undefined,
          { timeout: 240_000 },
        );
        await expect(compile).toBeEnabled({ timeout: 240_000 });
        await expect(
          page.getByRole("heading", { name: "Compilation Failed" }),
        ).toHaveCount(0);
      });
      result.pages = await page.locator(".mupdf-page").count();
      assert(result.pages >= 200);
      result.pdfSnapshotBytes = await Promise.all(
        (await fs.readdir(path.join(profile, "pdf-snapshots"))).map(
          async (file) =>
            (await fs.stat(path.join(profile, "pdf-snapshots", file))).size,
        ),
      );
      await page.waitForTimeout(1500);
      await sample("compiled");
      await page.screenshot({
        path: path.join(output, `${run}-${name}-compiled.png`),
      });
      // Disable sync for independent source/PDF navigation; record the actual control.
      const sync = page.getByRole("button", {
        name: "Disable synchronized scrolling",
        exact: true,
      });
      if (await sync.count()) await sync.click();
      const syncControl = page.locator("[data-scroll-sync-muted]");
      await expect(syncControl).toHaveAttribute("aria-pressed", "false");
      result.scrollSync = await syncControl.getAttribute("aria-label");
      const editFile = page
        .locator(`[data-sidebar-file-id="${encodeURIComponent(fixture.edit)}"]`)
        .first();
      await phase("open-largest-source", () => editFile.click());
      await page.waitForTimeout(1500);
      const editor = page.locator(".cm-content").first();
      const originalText = await fs.readFile(
        path.join(project, fixture.edit),
        "utf8",
      );
      await editor.focus();
      await page.keyboard.press("ControlOrMeta+Home");
      await page.keyboard.insertText("% \n");
      await page.keyboard.press("ControlOrMeta+Home");
      await page.keyboard.press("ArrowRight");
      const typed = "Long paper typing benchmark. ".repeat(4);
      await phase("typing", () => page.keyboard.type(typed, { delay: 35 }));
      await expect
        .poll(() => fs.readFile(path.join(project, fixture.edit), "utf8"), {
          timeout: 15_000,
        })
        .toBe(`%${typed} \n${originalText}`);
      await phase("source-navigation", async () => {
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press(
            i % 2 ? "ControlOrMeta+Home" : "ControlOrMeta+End",
          );
          await page.waitForTimeout(150);
        }
      });
      await sample("after-editing");
      // Compile after an actual persisted edit, while the editor continues receiving keys.
      await editor.focus();
      await page.keyboard.press("ControlOrMeta+Home");
      await page.keyboard.press("ArrowRight");
      const concurrentText = "Typing during native compilation. ".repeat(4);
      await phase("recompile-while-typing", async () => {
        await compile.click();
        await editor.click({ position: { x: 20, y: 10 } });
        await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.type(concurrentText, {
          delay: 35,
        });
        await expect(compile).toBeEnabled({ timeout: 240_000 });
        await expect(
          page.getByRole("heading", { name: "Compilation Failed" }),
        ).toHaveCount(0);
      });
      await expect
        .poll(() => fs.readFile(path.join(project, fixture.edit), "utf8"), {
          timeout: 15_000,
        })
        .toBe(`%${concurrentText}${typed} \n${originalText}`);
      result.exactSavedText = true;
      await page.waitForTimeout(2000);
      await sample("before-view-cycles", true);
      for (let i = 0; i < cycles; i++) {
        await phase(`view-${i + 1}`, async () => {
          await page
            .getByRole("tab", { name: i % 2 ? "Split" : "PDF", exact: true })
            .click();
          await page.waitForTimeout(700);
        });
        if ((i + 1) % 5 === 0) await sample(`view-${i + 1}`, true);
      }
      await page.getByRole("tab", { name: "PDF", exact: true }).click();
      await page.waitForTimeout(1000);
      const visits = [
        ...new Set([
          1,
          Math.floor(result.pages / 4),
          Math.floor(result.pages / 2),
          result.pages - 1,
          result.pages,
          1,
        ]),
      ];
      visits.push(1);
      for (const number of visits) {
        await phase(`pdf-page-${number}`, async () => {
          await page
            .getByRole("button", { name: "Click to jump to page" })
            .click();
          const input = page.getByRole("textbox", { name: "Page number" });
          await input.fill(String(number));
          await input.press("Enter");
          await expect(
            page
              .getByRole("button", { name: "Click to jump to page" })
              .locator("[data-pdf-page-current]"),
          ).toHaveText(String(number));
          await page.waitForFunction(
            (number) =>
              document.querySelector(
                `[data-page-number="${number}"] [data-pdf-page-canvas]`,
              )?.dataset.pdfRenderedScale,
            number,
          );
        });
        if (number === Math.floor(result.pages / 2))
          await page.screenshot({
            path: path.join(output, `${run}-${name}-middle.png`),
          });
      }
      await phase("pdf-scroll", async () => {
        const bounds = await page.locator(".mupdf-page").first().boundingBox();
        await page.mouse.move(bounds.x + bounds.width / 2, 450);
        for (let i = 0; i < 60; i++) {
          await page.mouse.wheel(0, 150);
          await page.waitForTimeout(50);
        }
      });
      if (process.env.CATALEX_LONG_PAPER_ALL_PAGES === "1") {
        result.pageVisitsMs = [];
        await phase("pdf-all-pages", async () => {
          for (let number = 1; number <= result.pages; number++) {
            const start = performance.now();
            await page
              .locator(`[data-page-number="${number}"]`)
              .evaluate((el) =>
                el.scrollIntoView({ block: "center", behavior: "instant" }),
              );
            await page.waitForFunction(
              (number) =>
                document.querySelector(
                  `[data-page-number="${number}"] [data-pdf-page-canvas]`,
                )?.dataset.pdfRenderedScale,
              number,
              { timeout: 15_000 },
            );
            result.pageVisitsMs.push(performance.now() - start);
            if (number % 100 === 0) {
              await sample(`page-${number}`);
              console.log(`${name}: visited ${number}/${result.pages} pages`);
            }
          }
        });
        result.pageVisitSummary = summary(result.pageVisitsMs);
      }
      await sample("after-pdf-navigation", true);
      result.inverseProbe = await page.evaluate(
        ({ project, number }) =>
          window.catalex.invoke("synctex_edit", {
            projectDir: project,
            page: number,
            x: 150,
            y: 400,
          }),
        { project, number: Math.floor(result.pages / 2) },
      );
      assert.equal(result.inverseProbe.error, undefined);
      assert(result.inverseProbe.result.line > 0);
      assert(
        fixture.files[result.inverseProbe.result.file],
        "Inverse search must resolve to a fixture source",
      );
      await page.screenshot({
        path: path.join(output, `${run}-${name}-final.png`),
      });
      await page
        .getByRole("button", { name: "Close project", exact: true })
        .first()
        .click();
      await page.getByTestId("welcome-new-project-menu-trigger").waitFor();
      await page.waitForTimeout(2000);
      await sample("closed-project", true);
      assert.equal(
        page.workers().filter((worker) => worker.url().includes("mupdf-worker"))
          .length,
        0,
        "Closing the project must release its MuPDF worker",
      );
      assert.deepEqual(result.errors, []);
      result.passed = true;
    } catch (error) {
      result.failure = String(error.stack ?? error);
      if (page) {
        await page
          .screenshot({ path: path.join(output, `${run}-${name}-failure.png`) })
          .catch(() => {});
        await fs.writeFile(
          path.join(output, `${run}-${name}-failure.txt`),
          await page
            .locator("body")
            .innerText()
            .catch(() => "Page unavailable"),
        );
      }
      throw error;
    } finally {
      result.finalIpc = await app
        .evaluate(() => globalThis.__longPaperNative)
        .catch(() => null);
      await fs.writeFile(
        path.join(output, `${run}.json`),
        `${JSON.stringify(results, null, 2)}\n`,
      );
      await app.close();
    }
  }
  console.log(`Results: ${path.join(output, `${run}.json`)}`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
