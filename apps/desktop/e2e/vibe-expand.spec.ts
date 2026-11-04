import { expect, test } from "@playwright/test";

type ScrollSyncProbeWindow = Window & {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  __scrollSyncProbe: { lines: number[]; release?: () => void };
};

test("Duet workspace expands a live panel and restores the split and chat draft", async ({
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
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
  await expect(chat.locator("[data-chat-composer-shell]")).toHaveAttribute(
    "data-composer-transfer-phase",
    "idle",
  );
  await expect(page.locator("[data-chat-drawer-overlay]")).toHaveCount(0);
  await input.fill("Keep this draft");
  await expect(input).toHaveValue("Keep this draft");
  await page
    .getByRole("button", { name: "Click to jump to page", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Page number", exact: true })
    .fill("3");
  await page
    .getByRole("textbox", { name: "Page number", exact: true })
    .press("Enter");
  const currentPage = page.locator("[data-pdf-page-current]").first();
  await expect(currentPage).toHaveText("3");
  const pdfScroller = await page
    .getByTestId("pdf-scroll-container")
    .elementHandle();
  const initial = await chat.boundingBox();
  for (const label of ["PDF", "Chat"]) {
    await page
      .getByRole("button", { name: `Expand ${label}`, exact: true })
      .click();
    const expanded = page.getByRole("dialog", {
      name: `${label} expanded`,
      exact: true,
    });
    await expect(expanded).toBeVisible();
    if (label === "PDF") {
      await expect(currentPage).toHaveText("3");
      expect(
        await pdfScroller!.evaluate((element) => element.isConnected),
      ).toBe(true);
    }
    await expect(expanded).not.toHaveAttribute(
      "data-panel-expansion-motion",
      /.+/,
    );
    const bounds = await expanded.boundingBox();
    expect(bounds!.x).toBe(12);
    expect(bounds!.y).toBe(36);
    expect(bounds!.width).toBe(1416);
    expect(bounds!.height).toBe(852);
    await page.screenshot({
      path: test.info().outputPath(`expanded-${label}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(expanded).toHaveCount(0);
    await expect(input).toHaveValue("Keep this draft");
    await expect(currentPage).toHaveText("3");
    expect((await chat.boundingBox())!.width).toBeCloseTo(initial!.width, 0);
  }
  await page
    .getByRole("tablist", { name: "Chat workspace content" })
    .getByRole("tab", { name: "Editor", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Expand Editor", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Editor expanded",
    exact: true,
  });
  await expect(editor.locator("[data-editor-toolbar]")).toHaveCount(0);
  await expect(editor.getByTestId("latex-editor-toolbar")).toBeVisible();
  await expect(editor.locator(".cm-content")).toBeVisible();
  await expect(editor).not.toHaveAttribute("data-panel-expansion-motion");
  await page.screenshot({
    path: test.info().outputPath("expanded-editor.png"),
  });
  await page
    .getByRole("button", { name: "Restore Editor", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  await expect(input).toHaveValue("Keep this draft");
  expect((await chat.boundingBox())!.width).toBeCloseTo(initial!.width, 0);
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
