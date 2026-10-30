import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

for (const count of [0, 50, 200]) {
  test(`measures ${count} additional offscreen comments`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(
      `/?debug=pdf-comments&performance&offscreenComments=${count}`,
    );
    await page
      .getByRole("button", { name: "Edit commented source", exact: true })
      .click();
    await expect(page.locator(".cm-content")).toContainText("Source context");
    await page.locator(".cm-content").focus();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    const read = () =>
      page.evaluate(
        () =>
          (window as any).__offscreen?.comments ??
          JSON.parse(
            localStorage.getItem(
              "catalex-harness-comments:/tmp/catalex-pdf-comments-harness",
            )!,
          )["chapter.tex"],
      );
    const before = await read();
    expect(before.length).toBe(count + 8);
    const cardsBefore = await page.locator(".cm-inlineCommentCard").count();
    await page.evaluate((noSaveEcho) => {
      const win = window as any;
      win.__offscreen = {
        writes: 0,
        frames: [],
        comments: noSaveEcho
          ? JSON.parse(
              localStorage.getItem(
                "catalex-harness-comments:/tmp/catalex-pdf-comments-harness",
              )!,
            )["chapter.tex"]
          : undefined,
      };
      const invoke = win.__TAURI_INTERNALS__.invoke;
      win.__TAURI_INTERNALS__.invoke = (cmd: string, ...args: unknown[]) => {
        if (
          [
            "update_project_comment",
            "update_project_comment_anchored",
            "update_project_comment_anchors",
          ].includes(cmd)
        ) {
          win.__offscreen.writes++;
          if (noSaveEcho) {
            const payload = args[0] as any;
            const patches = payload.patches ?? [payload.patch];
            const updates = new Map(
              patches.map((patch: any) => [patch.id, patch.after]),
            );
            win.__offscreen.comments = win.__offscreen.comments.map(
              (comment: any) => updates.get(comment.id) ?? comment,
            );
            return Promise.resolve(
              cmd === "update_project_comment_anchors"
                ? { orphanedIds: [] }
                : payload.patch,
            );
          }
        }
        return invoke(cmd, ...args);
      };
      document.addEventListener("keydown", () => {
        const start = performance.now();
        requestAnimationFrame(() =>
          win.__offscreen.frames.push(performance.now() - start),
        );
      });
    }, Boolean(process.env.OFFSCREEN_NO_SAVE_ECHO));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    const typed = "Offscreen test text. ";
    const start = Date.now();
    await page.keyboard.type(typed, { delay: 40 });
    await page.waitForTimeout(300);
    const { profile } = await cdp.send("Profiler.stop");
    const wallMs = Date.now() - start;
    const metrics = await page.evaluate(() => (window as any).__offscreen);
    const frames = metrics.frames.sort((a: number, b: number) => a - b);
    const after = await read();
    expect(after.map((c: any) => [c.from, c.to])).toEqual(
      before.map((c: any) => [c.from + typed.length, c.to + typed.length]),
    );
    const cardsAfter = await page.locator(".cm-inlineCommentCard").count();
    expect(cardsAfter).toBeLessThan(15);
    const report = {
      persistence: process.env.OFFSCREEN_NO_SAVE_ECHO
        ? "no-save-echo"
        : "full-browser-mock",
      extraOffscreenComments: count,
      totalComments: after.length,
      keystrokes: typed.length,
      cardsBefore,
      cardsAfter,
      commentWrites: metrics.writes,
      medianFrameMs: frames[Math.floor(frames.length * 0.5)],
      p95FrameMs: frames[Math.floor(frames.length * 0.95)],
      wallMs,
      note: "Development build. Native saves and compilation mocked. Frame latency is a proxy, not physical keyboard-to-display timing.",
    };
    console.log(JSON.stringify(report));
    await writeFile(
      info.outputPath("offscreen.json"),
      JSON.stringify(report, null, 2),
    );
    await writeFile(
      info.outputPath("typing.cpuprofile"),
      JSON.stringify(profile),
    );
    if (count) {
      await page.evaluate(async () => {
        const { useDocumentStore } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        const saved = JSON.parse(
          localStorage.getItem(
            "catalex-harness-comments:/tmp/catalex-pdf-comments-harness",
          )!,
        )["chapter.tex"];
        useDocumentStore
          .getState()
          .requestJumpToPosition(
            saved.find((c: any) => c.id === "offscreen-0").from,
          );
      });
      await expect(
        page
          .locator(".cm-inlineCommentCard")
          .filter({ hasText: "Offscreen review comment 1" })
          .first(),
      ).toBeVisible();
    }
    await page.screenshot({ path: info.outputPath("comments.png") });
    await cdp.detach();
  });
}
