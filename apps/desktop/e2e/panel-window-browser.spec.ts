import { expect, type Locator, type Page, test } from "@playwright/test";

async function openExpandAction(page: Page, label: string) {
  await page
    .getByRole("button", { name: `More ${label} view actions`, exact: true })
    .click();
  return page.getByRole("menuitem", { name: `Expand ${label}`, exact: true });
}

async function expectBalancedSeparator(toolbar: Locator, previous: Locator) {
  await expect(async () => {
    const before = (await previous.boundingBox())!;
    const divider = (await toolbar
      .locator("[data-panel-control-separator]")
      .boundingBox())!;
    const controls = (await toolbar
      .getByRole("group", { name: /view actions/ })
      .boundingBox())!;
    expect(divider.x - (before.x + before.width)).toBeCloseTo(8, 1);
    expect(controls.x - (divider.x + divider.width)).toBeCloseTo(8, 1);
  }).toPass();
}

test("window-control separators follow visible right-aligned header content", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(
    page.locator("[data-pdf-toolbar] [data-panel-control-separator]"),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("latex-editor-toolbar")
      .locator("[data-panel-control-separator]"),
  ).toBeVisible();
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  const pdfToolbar = page.locator("[data-pdf-toolbar]");
  await expectBalancedSeparator(
    pdfToolbar,
    pdfToolbar.getByRole("group", { name: "PDF zoom", exact: true }),
  );
  const editorToolbar = page.getByTestId("latex-editor-toolbar");
  const editorPanel = page.locator("[data-workspace-panel-screen]").filter({
    has: editorToolbar,
  });
  await editorPanel
    .getByRole("button", { name: "Hide comments", exact: true })
    .click();
  const editorSummary = editorToolbar.getByRole("button", {
    name: /Show comments:/,
  });
  await expect(editorSummary).toBeVisible();
  await expectBalancedSeparator(editorToolbar, editorSummary);
  await page.screenshot({
    path: test.info().outputPath("balanced-header-gaps.png"),
  });
  await editorSummary.click();
  await expectBalancedSeparator(
    editorToolbar,
    page.getByTestId("latex-editor-statistics"),
  );
  await page.addInitScript(() => {
    localStorage.setItem(
      "catalex-harness-comments:/tmp/markdown-preview-harness",
      JSON.stringify({
        "README.md": [
          {
            id: "header-separator-comment",
            from: 27,
            to: 51,
            line: 3,
            text: "Review this phrase",
          },
        ],
      }),
    );
  });
  await page.goto("/?debug=markdown-workspace");
  const preview = page.getByTestId("markdown-preview");
  const toolbar = page.getByTestId("markdown-preview-toolbar");
  const separator = toolbar.locator("[data-panel-control-separator]");
  await expect(
    toolbar.getByRole("button", {
      name: "More Preview view actions",
      exact: true,
    }),
  ).toBeVisible();
  await expect(separator).not.toBeVisible();
  await expect(
    page
      .getByTestId("markdown-editor-toolbar")
      .locator("[data-panel-control-separator]"),
  ).toBeVisible();
  await toolbar.screenshot({
    path: test.info().outputPath("preview-controls-alone.png"),
  });
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  const hideComments = preview.getByRole("button", {
    name: "Hide comments",
    exact: true,
  });
  if (await hideComments.isVisible()) await hideComments.click();
  const summary = toolbar.getByRole("button", { name: /Show comments:/ });
  await expect(summary).toBeVisible();
  await expectBalancedSeparator(toolbar, summary);
  await expect(separator).toBeVisible();
  await toolbar.screenshot({
    path: test.info().outputPath("preview-comment-separator.png"),
  });
  await summary.click();
  await expect(hideComments).toBeVisible();
  await expect(separator).not.toBeVisible();
  await hideComments.click();
  await expect(separator).toBeVisible();
});

test("panel actions stay visible while expanded and restore through the same menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  const toolbar = page.locator("[data-pdf-toolbar]");
  const control = toolbar.locator(".workspace-panel-control-motion");
  const original = await toolbar
    .getByRole("button", { name: "More PDF view actions", exact: true })
    .elementHandle();
  const fullWidth = (await control.boundingBox())!.width;

  for (const action of ["Expand PDF", "Restore PDF"]) {
    await toolbar
      .getByRole("button", { name: "More PDF view actions", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Pop out PDF", exact: true }),
    ).toBeVisible();
    const button = await page
      .getByRole("menuitem", { name: action, exact: true })
      .elementHandle();
    const samples = await button!.evaluate(async (button) => {
      const panel = document.querySelector(
        '[data-workspace-column="preview"]',
      )!;
      const header = panel.querySelector<HTMLElement>(
        ".workspace-panel-control-motion",
      )!;
      const top = panel.querySelector<HTMLElement>(
        ".fixed .problems-motion-content",
      )!;
      const samples: { width: number; opacity: number }[] = [];
      button.click();
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const sample = () => {
          samples.push({
            width: header.getBoundingClientRect().width,
            opacity: Number(getComputedStyle(top).opacity),
          });
          if (performance.now() - start < 900) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
      return samples;
    });
    expect(samples.every(({ width }) => Math.abs(width - fullWidth) < 1)).toBe(
      true,
    );
    expect(samples.some(({ opacity }) => opacity > 0 && opacity < 1)).toBe(
      true,
    );
    const last = samples.at(-1)!;
    expect(last.width).toBeCloseTo(fullWidth, 0);
    await expect(
      toolbar.getByRole("button", {
        name: "More PDF view actions",
        exact: true,
      }),
    ).toBeVisible();
    expect(last.opacity).toBe(action === "Expand PDF" ? 1 : 0);
    expect(await original!.evaluate((element) => element.isConnected)).toBe(
      true,
    );
  }
  await expect(page.getByTestId("pdf-scroll-container")).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(control).toHaveCSS("transition-duration", "0s");
});

test("browser demo opens synchronized editor and PDF pop-outs", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  const opened = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "More Editor view actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", {
      name: "Pop out Editor",
      exact: true,
    })
    .click();
  const editor = await opened;
  editor.on("pageerror", (error) => errors.push(error.message));
  const content = editor.locator(".cm-content");
  await expect(content).toBeVisible();
  await expect(
    editor.getByRole("button", {
      name: "More Editor view actions",
      exact: true,
    }),
  ).toBeVisible();
  await expect(editor.getByTestId("latex-editor-statistics")).toBeVisible();
  await expect(
    editor.getByRole("button", {
      name: "More Editor view actions",
      exact: true,
    }),
  ).toBeDisabled();
  await content.focus();
  await editor.keyboard.press("ControlOrMeta+Home");
  await editor.keyboard.insertText("% Browser pop-out edit\n");
  await expect(page.locator(".cm-content")).toContainText(
    "Browser pop-out edit",
  );
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.insertText("% Main browser edit\n");
  await expect(content).toContainText("Main browser edit");
  await expect(editor.locator("[data-panel-window-title]")).toBeInViewport();
  await expect(
    editor.getByRole("button", {
      name: "More Editor view actions",
      exact: true,
    }),
  ).toBeInViewport();
  await editor.screenshot({
    path: test.info().outputPath("browser-editor-popout.png"),
  });
  const pdfOpened = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "More PDF view actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Pop out PDF", exact: true })
    .click();
  const pdf = await pdfOpened;
  pdf.on("pageerror", (error) => errors.push(error.message));
  await expect(pdf.locator(".mupdf-text-layer").first()).toBeVisible();
  await expect(
    pdf.getByRole("button", { name: "More PDF view actions", exact: true }),
  ).toBeVisible();
  await expect(
    pdf.getByRole("button", { name: "Recompile", exact: true }),
  ).toBeVisible();
  await expect(pdf.locator("[data-panel-window-title]")).toBeInViewport();
  await expect(
    pdf.getByRole("button", { name: "More PDF view actions", exact: true }),
  ).toBeInViewport();
  await pdf.screenshot({
    path: test.info().outputPath("browser-pdf-popout.png"),
  });
  await pdf.setViewportSize({ width: 320, height: 720 });
  const pdfActions = pdf.getByRole("button", {
    name: "More PDF view actions",
    exact: true,
  });
  await expect(pdfActions).toBeEnabled();
  await pdfActions.click();
  await expect(pdf.getByRole("menu")).toBeVisible();
  await expect(
    pdf.getByRole("menuitem", { name: /Expand|Restore|Pop out/ }),
  ).toHaveCount(0);
  await expect(
    pdf.getByRole("menuitem", { name: "Fit height", exact: true }),
  ).toBeVisible();
  await pdf.screenshot({
    path: test.info().outputPath("browser-pdf-popout-overflow.png"),
  });
  await pdf.keyboard.press("Escape");
  await pdf.setViewportSize({ width: 1440, height: 900 });
  await expect(pdfActions).toBeDisabled();
  await page.screenshot({
    path: test.info().outputPath("browser-popout-controls.png"),
  });
  expect(errors).toEqual([]);
  await editor.close();
  await pdf.close();
});

test("ellipsis opens panel actions without expanding and supports keyboard navigation", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&pdf");
  const primary = page.getByRole("button", {
    name: "More Editor view actions",
    exact: true,
  });
  await expect(primary).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Expand Editor", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Pop out Editor", exact: true }),
  ).toHaveCount(0);
  await primary.click();
  await expect(
    page.getByRole("dialog", { name: "Editor expanded", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Expand Editor", exact: true }),
  ).toContainText("Expand panel");
  await expect(
    page.getByRole("menuitem", { name: "Pop out Editor", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("panel-actions-menu.png"),
  });
  await page.keyboard.press("Escape");
  await expect(primary).toBeFocused();
  await primary.press("Enter");
  await page
    .getByRole("menuitem", { name: "Expand Editor", exact: true })
    .press("Enter");
  const panel = page.getByRole("dialog", {
    name: "Editor expanded",
    exact: true,
  });
  await expect(panel).not.toHaveAttribute("data-panel-expansion-motion");
  const actions = panel.locator("[data-expanded-panel-actions]");
  const restore = actions.getByRole("button", {
    name: "Restore Editor",
    exact: true,
  });
  const popout = actions.getByRole("button", {
    name: "Pop out Editor",
    exact: true,
  });
  await expect(restore).toBeVisible();
  await expect(popout).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Expand Editor", exact: true }),
  ).toHaveCount(0);
  const bounds = await panel.boundingBox();
  for (const button of [restore, popout]) {
    const rect = await button.boundingBox();
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(bounds!.y);
    await button.click({ trial: true });
  }
  await page.screenshot({
    path: test.info().outputPath("expanded-top-actions.png"),
  });
  await restore.focus();
  if (await page.getByRole("tooltip").isVisible()) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".cm-content")).toBeFocused();
  await (await openExpandAction(page, "Editor")).click();
  await expect(panel).not.toHaveAttribute("data-panel-expansion-motion");
  const opened = page.waitForEvent("popup");
  await popout.click();
  const child = await opened;
  await expect(child.locator(".cm-content")).toBeVisible();
  await expect(panel).toHaveCount(0);
  await child.close();
});

test("header separators keep 8px spacing across toolbar widths", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&pdf");
  const toolbar = page.getByTestId("latex-editor-toolbar");
  const formatting = toolbar.locator("[data-formatting-collapsed]");
  const statistics = page.getByTestId("latex-editor-statistics");
  for (const width of [2200, 1200, 2200]) {
    await page.setViewportSize({ width, height: 900 });
    await expectBalancedSeparator(toolbar, statistics);
    await expect(formatting).toHaveAttribute(
      "data-formatting-collapsed",
      width === 1200 ? "true" : "false",
    );
    await toolbar.screenshot({
      path: test.info().outputPath(`fixed-spacing-${width}.png`),
    });
  }
});

test("blank headers toggle focus, ignore controls and support Alt double-click pop-out", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  const header = page.getByTestId("latex-editor-toolbar");
  const space = header.locator("[data-panel-header-space]");
  await expect(space).toBeVisible();
  await page.getByTestId("latex-editor-statistics").dblclick();
  await expect(
    page.getByRole("dialog", { name: "Editor expanded" }),
  ).toHaveCount(0);
  await space.dblclick();
  const expanded = page.getByRole("dialog", { name: "Editor expanded" });
  await expect(expanded).toBeVisible();
  await expect(
    header.getByRole("button", { name: "More Editor view actions" }),
  ).toBeVisible();
  await space.dblclick();
  await expect(expanded).toHaveCount(0);
  const opened = page.waitForEvent("popup");
  await space.dblclick({ modifiers: ["Alt"] });
  const child = await opened;
  await expect(child.locator(".cm-content")).toBeVisible();
  await expect(expanded).toHaveCount(0);
  await child.close();
  const pdfHeader = page.locator("[data-pdf-toolbar]");
  const pdfSpace = pdfHeader.locator("[data-panel-header-space]");
  await pdfSpace.dblclick();
  await expect(
    page.getByRole("dialog", { name: "PDF expanded" }),
  ).toBeVisible();
  await pdfSpace.dblclick();
  await expect(page.getByRole("dialog", { name: "PDF expanded" })).toHaveCount(
    0,
  );
});

for (const kind of ["latex", "markdown"] as const) {
  test(`${kind} editor overflows statistics only after formatting collapses`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.goto(
      kind === "latex"
        ? "/?debug=comment-workspace&pdf"
        : "/?debug=markdown-workspace",
    );
    const header = page.getByTestId(`${kind}-editor-toolbar`);
    const statistics = page.getByTestId(`${kind}-editor-statistics`);
    const formatting = header.locator("[data-formatting-collapsed]");
    await expect(statistics).toBeVisible();
    const stages = new Set<string>();
    for (const width of [1800, 1400, 1200, 1000, 900, 800, 700]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const collapsed =
        (await formatting.getAttribute("data-formatting-collapsed")) === "true";
      const overflow =
        (await header.getAttribute("data-editor-statistics-overflow")) ===
        "true";
      if (overflow) expect(collapsed).toBe(true);
      stages.add(overflow ? "overflow" : collapsed ? "compact" : "full");
      expect(
        await header
          .locator("[data-panel-header-space]")
          .evaluate((el) => el.getBoundingClientRect().width),
      ).toBe(56);
      expect(
        await header.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
    }
    expect([...stages]).toEqual(["full", "compact", "overflow"]);
    await expect(statistics).not.toBeVisible();
    await page.locator(".cm-content").focus();
    await page.keyboard.press("ControlOrMeta+a");
    const words = (
      await page.getByTestId(`${kind}-word-count`).innerText()
    ).replace(" words", "");
    const characters = (
      await page.getByTestId(`${kind}-character-count`).innerText()
    ).replace(" chars", "");
    await header
      .getByRole("button", { name: "More Editor view actions", exact: true })
      .click();
    const menuStatistics = page.locator("[data-editor-statistics-menu]");
    await expect(menuStatistics).toContainText(words);
    await expect(menuStatistics).toContainText(characters);
    await page.getByRole("menu").screenshot({
      path: testInfo.outputPath(`${kind}-statistics-menu.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1800, height: 900 });
    await expect(statistics).toBeVisible();
    await expect(header).toHaveAttribute(
      "data-editor-statistics-overflow",
      "false",
    );
    await header
      .getByRole("button", { name: "More Editor view actions", exact: true })
      .click();
    await expect(menuStatistics).toHaveCount(0);
  });
}
