import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const activity = process.env.SESSION_ACTIVITY ?? "combined";
for (const extra of process.env.SESSION_ACTIVITY ? [0] : [0, 50]) {
  test(`${activity} session with ${extra} extra comments`, async ({
    page,
  }, info) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    let workers = 0;
    page.on("worker", () => workers++);
    await page.goto(
      `${process.env.CATALEX_PERFORMANCE_BUILD ? "/dev/typing-performance.html?" : "/?debug=pdf-comments&"}performance&offscreenComments=${extra}`,
    );
    await expect(
      page.locator('[data-page-number="1"] .mupdf-text-layer'),
    ).toContainText("Your abstract here.");
    await page
      .getByRole("button", { name: "Edit commented source", exact: true })
      .click();
    await expect(page.locator(".cm-content")).toContainText("Source context");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await page.evaluate(() => {
      const win = window as any;
      win.__sessionProbe = { frames: [] as number[], started: 0, completed: 0 };
      const invoke = win.__TAURI_INTERNALS__.invoke;
      win.__TAURI_INTERNALS__.invoke = async (
        command: string,
        ...args: unknown[]
      ) => {
        if (command !== "update_project_comment")
          return invoke(command, ...args);
        win.__sessionProbe.started++;
        try {
          return await invoke(command, ...args);
        } finally {
          win.__sessionProbe.completed++;
        }
      };
      document.addEventListener("keydown", () => {
        const start = performance.now();
        requestAnimationFrame(() =>
          win.__sessionProbe.frames.push(performance.now() - start),
        );
      });
    });
    const saved = () =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem(
              "catalex-harness-comments:/tmp/catalex-pdf-comments-harness",
            )!,
          )["chapter.tex"],
      );
    const initialAnchors = (await saved()).map((c: any) => [c.from, c.to]);
    const text = "Repeated editing checks for retained work. ";
    const samples: unknown[] = [];
    let initialStyles: number | undefined;
    for (
      let round = 0;
      round < Number(process.env.SESSION_ROUNDS ?? 9);
      round++
    ) {
      await page.locator(".cm-content").focus();
      await page.keyboard.press("ControlOrMeta+Home");
      await page.keyboard.press("ArrowRight");
      await page.evaluate(() => {
        (window as any).__sessionProbe.frames = [];
      });
      await page.keyboard.type(text, { delay: 25 });
      for (let i = 0; i < text.length; i++)
        await page.keyboard.press("Backspace");
      const expectedWrites = (round + 1) * text.length * 2 * (extra + 8);
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).__sessionProbe.completed),
        )
        .toBe(expectedWrites);
      expect((await saved()).map((c: any) => [c.from, c.to])).toEqual(
        initialAnchors,
      );
      const frames = await page.evaluate(() =>
        [...(window as any).__sessionProbe.frames].sort(
          (a: number, b: number) => a - b,
        ),
      );
      if (activity !== "edit" && activity !== "switch") {
        await page
          .getByRole("button", { name: "Refresh fixture PDF", exact: true })
          .click();
        await expect(
          page.locator('[data-page-number="1"] .mupdf-text-layer'),
        ).toContainText("Your abstract here.");
      }
      // Switching files exercises editor teardown and restoration of cached history.
      for (const file of activity === "combined" || activity === "switch"
        ? ["main.tex", "chapter.tex"]
        : []) {
        await page
          .getByRole("button", {
            name:
              file === "main.tex"
                ? "Edit main source"
                : "Edit commented source",
            exact: true,
          })
          .click();
        await expect(page.locator(".cm-content")).toBeVisible();
        if (file === "main.tex")
          await expect(page.locator(".cm-content")).not.toContainText(
            "Source context",
          );
        else
          await expect(page.locator(".cm-content")).toContainText(
            "Source context",
          );
      }
      await page.waitForTimeout(300);
      await cdp.send("HeapProfiler.collectGarbage");
      const { metrics } = await cdp.send("Performance.getMetrics");
      const values = Object.fromEntries(
        metrics.map(({ name, value }) => [name, value]),
      );
      const styles = await page.evaluate(() =>
        [...document.styleSheets]
          .filter((sheet) => !sheet.href)
          .reduce((sum, sheet) => sum + sheet.cssRules.length, 0),
      );
      initialStyles ??= styles;
      expect(styles).toBe(initialStyles);
      const sample = {
        round,
        medianMs: frames[Math.floor(frames.length / 2)],
        p95Ms: frames[Math.floor(frames.length * 0.95)],
        heapMB: values.JSHeapUsedSize / 1024 / 1024,
        nodes: values.Nodes,
        listeners: values.JSEventListeners,
        documents: values.Documents,
        styles,
        workers,
        writes: expectedWrites,
      };
      samples.push(sample);
      console.log(JSON.stringify({ extra, ...sample }));
    }
    await writeFile(
      info.outputPath("session.json"),
      JSON.stringify(samples, null, 2),
    );
    await page.screenshot({ path: info.outputPath("session.png") });
    if (process.env.SESSION_HEAP) {
      const chunks: string[] = [];
      cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) =>
        chunks.push(chunk),
      );
      await cdp.send("HeapProfiler.takeHeapSnapshot");
      await writeFile(info.outputPath("session.heapsnapshot"), chunks.join(""));
    }
    await cdp.detach();
  });
}
