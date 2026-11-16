// Opt-in production Electron memory probe using the pinned long-paper fixtures.
// All annotations, compiler compatibility settings, and profiles are temporary.
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
const output = path.join(root, "output/playwright/long-paper-comments");
const run = process.env.CATALEX_LONG_COMMENT_RUN ?? "current";
assert.match(run, /^[a-zA-Z0-9_-]+$/);
const count = Number(process.env.CATALEX_LONG_COMMENT_PAGES ?? 40);
assert(Number.isInteger(count) && count >= 2 && count <= 200);
const commonFeatures = process.env.CATALEX_LONG_COMMENT_COMMON === "1";
const compiledPagePlan = process.env.CATALEX_LONG_COMMENT_PAGE_PLAN
  ? JSON.parse(
      await fs.readFile(process.env.CATALEX_LONG_COMMENT_PAGE_PLAN, "utf8"),
    )
  : null;
const cases = (
  process.env.CATALEX_LONG_COMMENT_CASES ?? "higher-topos,string-theory"
).split(",");
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-long-comments-"),
);
const fixtures = process.env.CATALEX_LONG_COMMENT_FIXTURES ?? temporary;
const results = {
  timestamp: new Date().toISOString(),
  driverSha256: createHash("sha256")
    .update(await fs.readFile(fileURLToPath(import.meta.url)))
    .digest("hex"),
  revision:
    process.env.CATALEX_LONG_COMMENT_REVISION ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  executable:
    process.env.CATALEX_LONG_COMMENT_HOST === "1"
      ? "Electron host with production renderer"
      : (process.env.CATALEX_LONG_COMMENT_EXECUTABLE ??
        path.join(
          desktop,
          "release/mac-arm64/Catalex.app/Contents/MacOS/Catalex",
        )),
  hardware: {
    cpu: os.cpus()[0]?.model,
    ramGiB: os.totalmem() / 2 ** 30,
    platform: os.platform(),
    arch: os.arch(),
  },
  requestedPages: count,
  commonFeatures,
  compiledPagePlan,
  cases: [],
};
await fs.mkdir(output, { recursive: true });
const persist = () =>
  fs.writeFile(
    path.join(output, `${run}.json`),
    `${JSON.stringify(results, null, 2)}\n`,
  );

try {
  if (!process.env.CATALEX_LONG_COMMENT_FIXTURES)
    execFileSync(
      "python3",
      [path.join(desktop, "e2e/long-paper-fixture.py"), temporary],
      { stdio: "inherit" },
    );
  for (const name of cases) {
    assert(["higher-topos", "string-theory"].includes(name));
    const fixtureRoot = path.join(fixtures, "fixtures", name);
    const fixture = JSON.parse(
      await fs.readFile(path.join(fixtureRoot, "fixture.json"), "utf8"),
    );
    const profile = await fs.mkdtemp(path.join(temporary, "profile-"));
    const project = path.join(profile, name);
    await fs.mkdir(project);
    const projectHashes = new Map();
    const encodingConversions = [];
    for (const [file, metadata] of Object.entries(fixture.files)) {
      let bytes = await fs.readFile(path.join(fixtureRoot, file));
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        metadata.sha256,
        file,
      );
      if (file.endsWith(".tex")) {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          bytes = Buffer.from(
            new TextDecoder("windows-1252").decode(bytes),
            "utf8",
          );
          encodingConversions.push(file);
        }
      }
      projectHashes.set(file, createHash("sha256").update(bytes).digest("hex"));
      await fs.mkdir(path.dirname(path.join(project, file)), {
        recursive: true,
      });
      await fs.writeFile(path.join(project, file), bytes);
    }
    // The source archives stay unchanged. Only these temporary copies use UTF-8,
    // as required by the native comment document reader and modern pdfLaTeX.
    const result = {
      name,
      fixture,
      encodingConversions,
      memory: [],
      operations: [],
      errors: [],
    };
    results.cases.push(result);
    const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CATALEX_DEV_URL;
    let app;
    let page;
    try {
      console.log(`${name}: launching isolated application`);
      app = await electron.launch({
        ...(process.env.CATALEX_LONG_COMMENT_HOST === "1"
          ? { args: [desktop] }
          : { executablePath: results.executable, args: [] }),
        env,
        timeout: 30000,
      });
      page = await app.firstWindow();
      console.log(`${name}: renderer connected`);
      const win = await app.browserWindow(page);
      await win.evaluate((window) => {
        window.unmaximize();
        window.setSize(1440, 1000);
        window.show();
        window.focus();
      });
      page.setDefaultTimeout(30000);
      page.on("pageerror", (error) => result.errors.push(error.message));
      await page.waitForFunction(
        () =>
          window.catalex && document.querySelector("#root")?.children.length,
      );
      console.log(`${name}: application ready`);
      await page.waitForLoadState("load");
      await page.evaluate((engine) => {
        localStorage.setItem(
          "catalex-onboarding",
          JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
        );
        const saved = JSON.parse(
          localStorage.getItem("catalex-settings") ?? "{}",
        );
        saved.state = {
          ...saved.state,
          defaultAutoCompile: false,
          compilerBackend: "latexmk",
          compilerEngine: engine,
          showPdfComments: true,
          displayComments: true,
        };
        localStorage.setItem("catalex-settings", JSON.stringify(saved));
      }, fixture.engine);
      await page.reload();
      console.log(`${name}: configured profile reloaded`);
      await page.locator("#loading-screen").waitFor({ state: "hidden" });
      await win.evaluate((window) => {
        window.unmaximize();
        window.setSize(1440, 1000);
        window.show();
        window.focus();
      });
      result.runtime = await app.evaluate(() => process.versions);
      result.viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      }));
      result.applicationVersion = await app.evaluate(({ app }) =>
        app.getVersion(),
      );
      if (process.env.CATALEX_LONG_COMMENT_EXPECTED_VERSION)
        assert.equal(
          result.applicationVersion,
          process.env.CATALEX_LONG_COMMENT_EXPECTED_VERSION,
        );
      let cdp = await page.context().newCDPSession(page);
      const invoke = (command, args = {}) =>
        page.evaluate(
          async ({ command, args }) => {
            const reply = await window.catalex.invoke(command, args);
            if (reply.error) throw new Error(JSON.stringify(reply.error));
            return reply.result;
          },
          { command, args },
        );
      const comments = () =>
        invoke("read_project_comments", { projectRoot: project });
      result.nativeVersion = (await invoke("get_system_info")).app_version;
      assert.equal(result.nativeVersion, result.applicationVersion);
      const sample = async (label) => {
        await page.evaluate(() => {
          window.getSelection()?.removeAllRanges();
        });
        await page.waitForTimeout(500);
        await cdp.send("HeapProfiler.collectGarbage");
        await cdp.send("HeapProfiler.collectGarbage");
        const processes = await app.evaluate(({ app }) =>
          app.getAppMetrics().map((p) => ({
            type: p.type,
            pid: p.pid,
            rssMiB: p.memory.workingSetSize / 1024,
          })),
        );
        const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .flatMap((line) => {
            const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
            return m
              ? [
                  {
                    pid: +m[1],
                    parent: +m[2],
                    rssMiB: +m[3] / 1024,
                    command: m[4],
                  },
                ]
              : [];
          });
        const descendants = new Set([app.process().pid]);
        for (let pass = 0; pass < rows.length; pass++) {
          const before = descendants.size;
          for (const row of rows)
            if (descendants.has(row.parent)) descendants.add(row.pid);
          if (before === descendants.size) break;
        }
        const value = {
          label,
          processes,
          native: rows.filter(
            (p) => descendants.has(p.pid) && /catalex-desktop/.test(p.command),
          ),
          workers: page.workers().map((w) => w.url()),
          heap: await cdp.send("Runtime.getHeapUsage"),
          dom: await cdp.send("Memory.getDOMCounters"),
          ui: await page.evaluate(() => ({
            nodes: document.querySelectorAll("*").length,
            pdfPages: document.querySelectorAll(".mupdf-page").length,
            textLines: document.querySelectorAll(".mupdf-text-layer text")
              .length,
            canvasMiB:
              [...document.querySelectorAll(".mupdf-page canvas")].reduce(
                (sum, c) => sum + c.width * c.height * 4,
                0,
              ) /
              2 ** 20,
          })),
        };
        result.memory.push(value);
        await persist();
        console.log(
          JSON.stringify({
            case: name,
            label,
            heapMiB: value.heap.usedSize / 2 ** 20,
            canvasMiB: value.ui.canvasMiB,
            processes,
            native: value.native,
          }),
        );
      };
      const screenshot = (label) =>
        page.screenshot({
          path: path.join(output, `${run}-${name}-${label}.png`),
        });
      const scroller = () =>
        page
          .getByTestId("pdf-scroll-container")
          .filter({ visible: true })
          .first();
      const visit = async (number) => {
        const paper = page
          .locator(`.mupdf-page[data-page-number="${number}"]`)
          .filter({ visible: true })
          .first();
        await paper.evaluate((el) =>
          el.scrollIntoView({ block: "center", behavior: "instant" }),
        );
        await expect(paper.locator("[data-pdf-page-canvas]")).toHaveAttribute(
          "data-pdf-rendered-scale",
          /.+/,
        );
        await expect
          .poll(() => paper.locator(".mupdf-text-layer text").count())
          .toBeGreaterThan(0);
        return paper;
      };
      const select = async (number, candidate = 0) => {
        const paper = await visit(number);
        const line = paper
          .locator(".mupdf-text-layer text")
          .filter({ hasText: /[A-Za-z][A-Za-z,;:' -]{24}/ })
          .nth(candidate);
        await line.scrollIntoViewIfNeeded();
        await scroller().focus();
        const text = await line.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const selected = window.getSelection();
          selected.removeAllRanges();
          selected.addRange(range);
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          return el.textContent;
        });
        // The viewer debounces mouseup. Wait until it publishes the selection.
        await expect(
          page.getByRole("button", { name: "Comment", exact: true }),
        ).toBeVisible();
        return { line, text };
      };
      const deselect = async () => {
        await scroller().press("Escape");
        await scroller().click({ position: { x: 10, y: 10 } });
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
        await expect(page.locator('[data-comment-chip="true"]')).toHaveCount(0);
        await expect(
          page.getByRole("button", {
            name: "Resize comment start",
            exact: true,
          }),
        ).toHaveCount(0);
      };
      const add = async (number, label, standalone) => {
        await deselect();
        let selected;
        const button = page.getByRole("button", {
          name: "Comment",
          exact: true,
        });
        for (let attempt = 0; attempt < (standalone ? 1 : 5); attempt++) {
          const paper = await visit(number);
          if (
            (await paper
              .locator(".mupdf-text-layer text")
              .filter({ hasText: /[A-Za-z][A-Za-z,;:' -]{24}/ })
              .count()) <= attempt
          )
            break;
          selected = await select(number, attempt);
          await expect(button).toBeVisible();
          await page.waitForTimeout(100);
          await expect
            .poll(() => button.getAttribute("aria-busy"), { timeout: 15000 })
            .not.toBe("true");
          if (await button.isEnabled()) break;
        }
        if (!(await button.isEnabled()) && !standalone) {
          (result.unmappedCompiledPages ??= []).push(number);
          await deselect();
          return;
        }
        await expect(button).toBeEnabled();
        await button.click();
        const card = page.getByRole("dialog", {
          name: "PDF comment",
          exact: true,
        });
        await card
          .getByRole("textbox", { name: "Comment text", exact: true })
          .fill(label);
        await card
          .getByRole("button", { name: "Save comment", exact: true })
          .click();
        await expect(card.getByText(label, { exact: true })).toBeVisible();
        if (standalone && !commonFeatures)
          await expect(
            page.getByRole("button", {
              name: "Resize comment start",
              exact: true,
            }),
          ).toBeVisible();
        await deselect();
        await select(number);
        if (standalone && !commonFeatures)
          await expect(
            page.locator('[data-comment-chip="true"]').first(),
          ).toContainText("reference.pdf");
        result.operations.push({
          label,
          page: number,
          standalone,
          selectedCharacters: selected.text.length,
        });
        await deselect();
      };
      await sample("welcome");
      await app.evaluate(({ dialog }, project) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [project],
        });
      }, project);
      await page.getByTestId("welcome-new-project-menu-trigger").click();
      await page
        .getByRole("menuitem", { name: "Open Folder", exact: true })
        .click();
      await page.locator(".cm-content").first().waitFor();
      await sample("source-opened");
      await page
        .locator(`[data-sidebar-file-id="${encodeURIComponent(fixture.main)}"]`)
        .first()
        .click();
      const compile = page.getByRole("button", {
        name: "Recompile",
        exact: true,
      });
      console.log(`${name}: compiling through native service`);
      await compile.click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("h2")].some(
            (el) => el.textContent === "Compilation Failed",
          ) ||
          (document.querySelectorAll(".mupdf-page").length >= 200 &&
            document.querySelector("[data-pdf-page-canvas]")?.width > 0),
        undefined,
        { timeout: 240000 },
      );
      await expect(compile).toBeEnabled({ timeout: 240000 });
      await expect(
        page.getByRole("heading", { name: "Compilation Failed" }),
      ).toHaveCount(0);
      result.pages = await page.locator(".mupdf-page").count();
      assert(result.pages >= 200);
      const sync = page.getByRole("button", {
        name: "Disable synchronized scrolling",
        exact: true,
      });
      if (await sync.count()) await sync.click();
      await page.getByRole("tab", { name: "PDF", exact: true }).click();
      await page.waitForTimeout(1000);
      await sample("compiled");
      const numbers = [
        ...new Set(
          Array.from(
            { length: count },
            (_, i) =>
              Math.ceil(result.pages * 0.05) +
              Math.floor((i * Math.floor(result.pages * 0.9)) / (count - 1)),
          ),
        ),
      ];
      result.testPages = numbers;
      for (const number of numbers) await visit(number);
      await visit(numbers[0]);
      await sample("compiled-control-navigation");
      await select(numbers[0]);
      const firstComment = page.getByRole("button", {
        name: "Comment",
        exact: true,
      });
      await page.waitForTimeout(100);
      await expect
        .poll(() => firstComment.getAttribute("aria-busy"), { timeout: 30000 })
        .not.toBe("true");
      result.firstSelectionStatus =
        await firstComment.getAttribute("aria-description");
      await deselect();
      await sample("compiled-selection-only");
      const compiledNumbers = compiledPagePlan?.[name] ?? numbers;
      assert(
        compiledNumbers.every((number) => numbers.includes(number)),
        "Compiled plan must use the same control pages",
      );
      for (const [index, number] of compiledNumbers.entries()) {
        await add(number, `Compiled memory comment ${index + 1}`, false);
        if ((index + 1) % 10 === 0)
          await sample(`compiled-comments-${index + 1}`);
      }
      result.compiledComments = Object.values(await comments()).flat().length;
      assert(result.compiledComments >= 1);
      if (compiledPagePlan)
        assert.equal(result.compiledComments, compiledNumbers.length);
      await visit(numbers[0]);
      await sample("compiled-comments-deselected");
      await screenshot("compiled-comments");
      // Use the exact PDF produced by this app, as a standalone annotated file.
      const snapshots = await fs.readdir(path.join(profile, "pdf-snapshots"));
      const snapshot = snapshots.find((file) => file.endsWith(".pdf"));
      assert(snapshot, "Compilation must publish a native PDF snapshot");
      const reference = path.join(project, "reference.pdf");
      await fs.copyFile(
        path.join(profile, "pdf-snapshots", snapshot),
        reference,
      );
      result.pdfBytes = (await fs.stat(reference)).size;
      await expect(
        page.locator('[data-sidebar-file-id="reference.pdf"]').first(),
      ).toBeVisible();
      await page
        .locator('[data-sidebar-file-id="reference.pdf"]')
        .first()
        .click();
      await visit(numbers[0]);
      await sample("standalone-opened");
      for (const number of numbers) await visit(number);
      await visit(numbers[0]);
      await sample("standalone-control-navigation");
      for (const [index, number] of numbers.entries()) {
        await add(number, `Standalone memory comment ${index + 1}`, true);
        if ((index + 1) % 10 === 0)
          await sample(`standalone-comments-${index + 1}`);
      }
      let saved = await comments();
      result.standaloneComments = saved["reference.pdf"].length;
      assert.equal(result.standaloneComments, numbers.length);
      result.standaloneAnchors = saved["reference.pdf"].map((comment) => ({
        id: comment.id,
        number: comment.number,
        text: comment.text,
        pages: [...new Set(comment.pdf.regions.map((region) => region.page))],
      }));
      for (const [index, number] of numbers.entries())
        assert.deepEqual(
          result.standaloneAnchors.find(
            (comment) =>
              comment.text === `Standalone memory comment ${index + 1}`,
          )?.pages,
          [number],
        );
      for (let pass = 1; pass <= 2; pass++) {
        for (const number of numbers) {
          const paper = await visit(number);
          await paper
            .locator("[data-pdf-comment-highlight]")
            .first()
            .press("Enter");
          if (!commonFeatures)
            await expect(
              page.getByRole("button", {
                name: "Resize comment start",
                exact: true,
              }),
            ).toBeVisible();
          await deselect();
          await select(number);
          if (!commonFeatures)
            await expect(
              page.locator('[data-comment-chip="true"]').first(),
            ).toContainText("reference.pdf");
          await deselect();
        }
        await visit(numbers[0]);
        await sample(`standalone-repeat-${pass}`);
      }
      await select(numbers[0]);
      await screenshot("standalone-badges");
      await deselect();
      // Exercise distinct anchor versions through real resize controls.
      if (!commonFeatures) {
        const firstPaper = await visit(numbers[0]);
        const firstAnchor = async () =>
          (await comments())["reference.pdf"].find(
            (comment) => comment.text === "Standalone memory comment 1",
          ).pdf;
        const resizedAnchors = new Set();
        result.resizeOperations = [];
        await firstPaper
          .locator("[data-pdf-comment-highlight]")
          .first()
          .press("Enter");
        for (let i = 0; i < 30; i++) {
          const previous = await firstAnchor();
          const handle = page.getByRole("button", {
            name: "Resize comment start",
            exact: true,
          });
          await expect(handle).toBeVisible();
          await handle.hover();
          const box = await handle.boundingBox();
          const line = firstPaper
            .locator(".mupdf-text-layer text")
            .filter({ hasText: /[A-Za-z][A-Za-z,;:' -]{24}/ })
            .first();
          const point = await line.evaluate((el, index) => {
            const characters = Array.from(el.textContent ?? "");
            const limit = Math.min(
              characters.length - 6,
              el.x.baseVal.numberOfItems,
            );
            const offsets = characters.flatMap((character, offset) =>
              offset > 0 && offset < limit && character.trim() ? [offset] : [],
            );
            if (offsets.length < 20)
              throw new Error("Resize passage needs 20 character boundaries");
            const offset =
              offsets[Math.floor(((offsets.length - 1) * index) / 19)];
            // Explicit glyph positions preserve indices across SVG whitespace collapse.
            const p = new DOMPoint(
              el.x.baseVal.getItem(offset).value,
              el.y.baseVal.getItem(offset).value -
                Number(el.getAttribute("font-size")) * 0.3,
            ).matrixTransform(el.getScreenCTM());
            return { x: p.x, y: p.y, offset };
          }, i % 20);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(point.x, point.y, { steps: 8 });
          await expect
            .poll(async () => Math.abs((await handle.boundingBox()).x - box.x))
            .toBeGreaterThan(1);
          await page.mouse.up();
          await expect
            .poll(async () => JSON.stringify(await firstAnchor()))
            .not.toBe(JSON.stringify(previous));
          const next = await firstAnchor();
          resizedAnchors.add(JSON.stringify(next));
          result.resizeOperations.push({
            cycle: i + 1,
            svgOffset: point.offset,
            from: previous.text,
            to: next.text,
          });
          await deselect();
          await select(numbers[0]);
          await expect(
            page.locator('[data-comment-chip="true"]').first(),
          ).toContainText("reference.pdf");
          await deselect();
          await firstPaper
            .locator("[data-pdf-comment-highlight]")
            .first()
            .press("Enter");
        }
        result.resizeCycles = 30;
        result.distinctResizeAnchors = resizedAnchors.size;
        assert(resizedAnchors.size >= 20);
      } else result.resizeCycles = 0;
      await deselect();
      await sample(
        commonFeatures
          ? "standalone-after-interactions"
          : "standalone-after-resizing",
      );
      await invoke("clear_project_comments", {
        projectRoot: project,
        agent: false,
      });
      await expect
        .poll(async () => Object.values(await comments()).flat().length)
        .toBe(0);
      await expect(page.locator("[data-pdf-comment-highlight]")).toHaveCount(0);
      await visit(numbers[0]);
      await sample("comments-deleted");
      await page.waitForTimeout(5000);
      await sample("idle-after-delete");
      await page
        .getByRole("button", { name: "Close project", exact: true })
        .first()
        .click();
      await page.getByTestId("welcome-new-project-menu-trigger").waitFor();
      await page.waitForTimeout(2000);
      await sample("closed-project");
      assert.equal(
        page.workers().filter((w) => w.url().includes("mupdf-worker")).length,
        0,
      );
      for (const [file, expected] of projectHashes)
        assert.equal(
          createHash("sha256")
            .update(await fs.readFile(path.join(project, file)))
            .digest("hex"),
          expected,
          `Test source unchanged after opening: ${file}`,
        );
      assert.deepEqual(result.errors, []);
      await app.close();
      app = await electron.launch({
        ...(process.env.CATALEX_LONG_COMMENT_HOST === "1"
          ? { args: [desktop] }
          : { executablePath: results.executable, args: [] }),
        env,
        timeout: 30000,
      });
      page = await app.firstWindow();
      const restartedWindow = await app.browserWindow(page);
      await restartedWindow.evaluate((window) => {
        window.setSize(1440, 1000);
        window.show();
        window.focus();
      });
      await page.getByTestId("welcome-new-project-menu-trigger").waitFor();
      cdp = await page.context().newCDPSession(page);
      await sample("restarted-welcome");
      result.passed = true;
      saved = null;
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
      await persist();
      await app?.close();
    }
  }
  console.log(`Results: ${path.join(output, `${run}.json`)}`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
