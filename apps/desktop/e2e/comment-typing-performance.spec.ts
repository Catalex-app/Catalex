import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const storageKey = "catalex-harness-comments:/tmp/catalex-pdf-comments-harness";

function sampledCpu(profile: any) {
  const nodes = new Map<number, any>(
    profile.nodes.map((node: any) => [node.id, node]),
  );
  const parents = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id);
  const cpuMs = { commentUpdate: 0, pdfMatching: 0 };
  for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
    let id: number | undefined = profile.samples![index];
    const categories = new Set<keyof typeof cpuMs>();
    while (id !== undefined) {
      const frame = nodes.get(id)?.callFrame;
      if (
        frame &&
        /mapInlineCommentsThroughChanges|saveProjectInlineComments|commentPatches|buildInlineCommentDecorations/.test(
          frame.functionName,
        )
      )
        categories.add("commentUpdate");
      if (frame && /pdf-comment-selection|pdf-comments\.tsx/.test(frame.url))
        categories.add("pdfMatching");
      id = parents.get(id);
    }
    for (const category of categories)
      cpuMs[category] += (profile.timeDeltas?.[index] ?? 0) / 1000;
  }
  return cpuMs;
}

for (const visible of [true, false]) {
  test(`profiles typing with editor and PDF comments ${visible ? "visible" : "hidden"}`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(
      process.env.CATALEX_PERFORMANCE_BUILD
        ? "/dev/typing-performance.html?performance"
        : "/?debug=pdf-comments&performance",
    );
    await expect(page.locator("[data-pdf-comment-id]").first()).toBeVisible();
    await page
      .getByRole("button", { name: "Edit commented source", exact: true })
      .click();
    await expect(page.locator(".cm-content")).toContainText("Source context");
    await expect(page.locator("[data-pdf-comment-id]").first()).toBeVisible();
    const read = () =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!)["chapter.tex"],
        storageKey,
      );
    const before = await read();
    expect(
      before.filter((comment: { resolved?: boolean }) => !comment.resolved),
    ).toHaveLength(7);
    if (!visible) {
      await page
        .getByRole("button", { name: "Toggle comment visibility", exact: true })
        .click();
      await expect(page.locator(".cm-inlineCommentCard")).toHaveCount(0);
      await expect(page.locator("[data-pdf-comment-id]")).toHaveCount(0);
    }
    await page.locator(".cm-content").focus();
    await page.keyboard.press("ControlOrMeta+Home");
    // Edit inside a LaTeX comment so the existing PDF remains a valid fixture.
    await page.keyboard.press("ArrowRight");
    await page.evaluate(() => {
      const win = window as any;
      win.__typingMetrics = {
        frameDelays: [],
        commentWrites: 0,
        compileCalls: 0,
      };
      const original = win.__TAURI_INTERNALS__.invoke;
      win.__TAURI_INTERNALS__.invoke = (cmd: string, ...args: unknown[]) => {
        if (
          [
            "update_project_comment",
            "update_project_comment_anchored",
            "update_project_comment_anchors",
          ].includes(cmd)
        )
          win.__typingMetrics.commentWrites++;
        if (cmd === "compile_latex") win.__typingMetrics.compileCalls++;
        return original(cmd, ...args);
      };
      document.addEventListener("keydown", () => {
        const start = performance.now();
        requestAnimationFrame(() =>
          win.__typingMetrics.frameDelays.push(performance.now() - start),
        );
      });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    const typed = "Additional evaluation results. ".repeat(3);
    await page.keyboard.type(typed, { delay: 40 });
    // Include deferred counters and comment persistence after the last key.
    await page.waitForTimeout(300);
    const { profile } = await cdp.send("Profiler.stop");
    const metrics = await page.evaluate(() => (window as any).__typingMetrics);
    const sorted = metrics.frameDelays.sort((a: number, b: number) => a - b);
    await expect
      .poll(async () =>
        (await read()).map((comment: { from: number; to: number }) => [
          comment.from,
          comment.to,
        ]),
      )
      .toEqual(
        before.map((comment: { from: number; to: number }) => [
          comment.from + typed.length,
          comment.to + typed.length,
        ]),
      );
    if (!visible)
      await page
        .getByRole("button", { name: "Toggle comment visibility", exact: true })
        .click();
    await cdp.send("Profiler.start");
    const refreshStart = Date.now();
    await page
      .getByRole("button", { name: "Refresh fixture PDF", exact: true })
      .click();
    await expect(page.locator("[data-pdf-comment-id]").first()).toBeVisible();
    const refreshWallMs = Date.now() - refreshStart;
    const { profile: refreshProfile } = await cdp.send("Profiler.stop");
    const report = {
      build: process.env.CATALEX_PERFORMANCE_BUILD
        ? "production"
        : "development",
      visible,
      keystrokes: typed.length,
      medianFrameMs: sorted[Math.floor(sorted.length / 2)],
      p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
      commentWrites: metrics.commentWrites,
      compileCalls: metrics.compileCalls,
      typingSampledInclusiveCpuMs: process.env.CATALEX_PERFORMANCE_BUILD
        ? null
        : sampledCpu(profile),
      refreshSampledInclusiveCpuMs: process.env.CATALEX_PERFORMANCE_BUILD
        ? null
        : sampledCpu(refreshProfile),
      refreshWallMs,
      note: "Synthetic long source, seven overlapping comments, real PDF renderer and matching; native saves and compilation mocked. CPU samples are estimates and categories can overlap.",
    };
    console.log(JSON.stringify(report));
    for (const [name, value] of [
      ["typing-performance.json", report],
      ["typing.cpuprofile", profile],
      ["pdf-refresh.cpuprofile", refreshProfile],
    ] as const) {
      const path = info.outputPath(name);
      await writeFile(path, JSON.stringify(value, null, 2));
      await info.attach(name, { path, contentType: "application/json" });
    }
    await page.screenshot({
      path: info.outputPath("comments-after-typing.png"),
    });
    await cdp.detach();
  });
}
