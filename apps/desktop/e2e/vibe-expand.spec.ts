import { expect, test } from "@playwright/test";

type ScrollSyncProbeWindow = Window & {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  __scrollSyncProbe: { lines: number[]; release?: () => void };
};

test("Duet workspace expands content and restores its split without losing chat draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const chat = page.locator('[data-workspace-chat-pane="true"]');
  const input = chat.locator("textarea");
  await expect(input).toBeVisible();
  const mode = page.getByRole("tablist", { name: "Chat workspace content" });
  const area = page.locator('[data-workspace-mode-content="true"]');
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
  await expect
    .poll(async () => (await chat.boundingBox())!.width)
    .toBeGreaterThan(400);
  await expect(
    page.locator("[data-workspace-panel-screen] [data-chat-composer-shell]"),
  ).toHaveAttribute("data-composer-transfer-phase", "idle");
  const contentGroup = page.getByRole("group", {
    name: "Chat workspace content",
    exact: true,
  });
  const historyGroup = page.getByRole("group", {
    name: "Project history",
    exact: true,
  });
  for (const theme of ["modern", "classic"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.uiTheme = theme;
    }, theme);
    const contentStroke = await contentGroup
      .locator(".button-group-separator")
      .evaluate((element) => {
        const style = getComputedStyle(element, "::before");
        return { top: style.top, bottom: style.bottom, height: style.height };
      });
    expect(contentStroke).toEqual(
      theme === "modern"
        ? { top: "8px", bottom: "8px", height: "16px" }
        : { top: "0px", bottom: "0px", height: "32px" },
    );
    if (theme === "modern") {
      const historyStroke = await historyGroup
        .locator(".button-group-separator")
        .evaluate((element) => getComputedStyle(element, "::before").height);
      expect(historyStroke).toBe(contentStroke.height);
    }
    await contentGroup.screenshot({
      path: `test-results/chat-workspace-divider-${theme}.png`,
    });
    await historyGroup.screenshot({
      path: `test-results/history-workspace-divider-${theme}.png`,
    });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.uiTheme = "modern";
  });
  await input.fill("Keep this draft");
  const initial = await chat.boundingBox();
  await page
    .getByRole("button", { name: "Expand content panel", exact: true })
    .click();
  const restore = page.getByRole("button", {
    name: "Restore split layout",
    exact: true,
  });
  await expect(restore).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => (await chat.boundingBox())?.width ?? 0)
    .toBeLessThan(2);
  await expect(chat).toHaveAttribute("inert", "");
  await mode.getByRole("tab", { name: "Editor", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.locator(".cm-editor").boundingBox())!.width /
        (await area.boundingBox())!.width,
    )
    .toBeGreaterThan(0.95);
  await page.screenshot({
    path: test.info().outputPath("vibe-expanded-editor.png"),
  });
  await restore.click();
  await expect
    .poll(async () =>
      Math.abs((await chat.boundingBox())!.width - initial!.width),
    )
    .toBeLessThan(3);
  await expect(input).toHaveValue("Keep this draft");
  await page
    .getByRole("button", { name: "Expand content panel", exact: true })
    .click();
  await restore.click();
  await page.getByRole("button", { name: "Half", exact: true }).click();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Expand content panel", exact: true }),
  ).toBeVisible();
});

test("Duet workspace applies scroll mappings after switching to the destination panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page.evaluate(() => {
    const win = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (cmd: string, ...args: unknown[]) => Promise<unknown>;
      };
    };
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (cmd, ...args) => {
      if (cmd === "synctex_view") return { page: 3, x: 100, y: 300 };
      if (cmd === "synctex_edit")
        return { file: "sample.tex", line: 90, column: 1 };
      return invoke(cmd, ...args);
    };
  });
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const mode = page.getByRole("tablist", { name: "Chat workspace content" });
  const editor = page.locator(".cm-scroller");
  const pdf = page.getByTestId("pdf-scroll-container");
  const settle = async () => {
    await expect(
      page.locator("[data-workspace-layout-animating]"),
    ).toHaveAttribute("data-workspace-layout-animating", "false");
    await page.waitForTimeout(600);
  };
  await mode.getByRole("tab", { name: "Editor", exact: true }).click();
  await settle();
  await editor.evaluate((el) => {
    el.scrollTop = 900;
  });
  await page.waitForTimeout(150);
  await mode.getByRole("tab", { name: "PDF", exact: true }).click();
  await settle();
  await expect
    .poll(() => pdf.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(500);
  await pdf.evaluate((el) => {
    el.scrollTop += 400;
  });
  await page.waitForTimeout(200);
  await mode.getByRole("tab", { name: "Editor", exact: true }).click();
  await settle();
  await expect
    .poll(() => editor.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(2500);
  const visibleSource = await editor.locator(".cm-line").allTextContents();
  await mode.getByRole("tab", { name: "PDF", exact: true }).click();
  await settle();
  await mode.getByRole("tab", { name: "Editor", exact: true }).click();
  await settle();
  // Virtualized editor heights may change; verify the source region, not pixels.
  const reopenedSource = await editor.locator(".cm-line").allTextContents();
  expect(
    reopenedSource.some(
      (line) => line.trim().length > 20 && visibleSource.includes(line),
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("vibe-scroll-sync.png"),
  });
});

test("Duet workspace ignores an old PDF mapping after switching to a newer source region", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const mode = page.getByRole("tablist", { name: "Chat workspace content" });
  const editor = page.locator(".cm-scroller");
  const pdf = page.getByTestId("pdf-scroll-container");
  const settle = async () => {
    await expect(
      page.locator("[data-workspace-layout-animating]"),
    ).toHaveAttribute("data-workspace-layout-animating", "false");
    await page.waitForTimeout(600);
  };
  await mode.getByRole("tab", { name: "Editor", exact: true }).click();
  await settle();
  await page.evaluate(() => {
    const win = window as ScrollSyncProbeWindow;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    const probe: ScrollSyncProbeWindow["__scrollSyncProbe"] = { lines: [] };
    win.__scrollSyncProbe = probe;
    win.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "synctex_view") {
        probe.lines.push(Number(args?.line));
        if (probe.lines.length === 1) {
          return new Promise((resolve) => {
            probe.release = () => resolve({ page: 1, x: 100, y: 0 });
          });
        }
        return { page: 3, x: 100, y: 300 };
      }
      // This test isolates forward mapping; reverse mapping is covered above.
      if (cmd === "synctex_edit") return null;
      return invoke(cmd, args);
    };
  });
  await editor.evaluate((element) => {
    element.scrollTop = 900;
  });
  await page.waitForTimeout(150);
  await mode.getByRole("tab", { name: "PDF", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as ScrollSyncProbeWindow).__scrollSyncProbe.lines.length,
      ),
    )
    .toBe(1);

  // Leave while the first native lookup is still pending, then scroll elsewhere.
  await mode.getByRole("tab", { name: "Editor", exact: true }).click();
  await settle();
  await editor.evaluate((element) => {
    element.scrollTop = 2_000;
  });
  await page.waitForTimeout(150);
  await mode.getByRole("tab", { name: "PDF", exact: true }).click();
  await settle();
  await expect
    .poll(() => pdf.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(500);
  const lines = await page.evaluate(
    () => (window as ScrollSyncProbeWindow).__scrollSyncProbe.lines,
  );
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.at(-1)).toBeGreaterThan(lines[0]);
  const latestScroll = await pdf.evaluate((element) => element.scrollTop);
  await page.evaluate(() =>
    (window as ScrollSyncProbeWindow).__scrollSyncProbe.release?.(),
  );
  await page.waitForTimeout(500);
  expect(await pdf.evaluate((element) => element.scrollTop)).toBeCloseTo(
    latestScroll,
    0,
  );
  await page.screenshot({
    path: test.info().outputPath("vibe-scroll-sync-latest.png"),
  });
});
