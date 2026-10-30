import { expect, test } from "@playwright/test";

test("keeps the Markdown cursor in place during preview scroll sync", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview", {
    waitUntil: "domcontentloaded",
  });

  const cursorPosition = page.getByTestId("markdown-editor-cursor-position");
  const cursorBeforePreviewScroll = await cursorPosition.textContent();
  const editorScroller = page.locator(".cm-scroller");
  const previewFrame = page.locator('iframe[title="README.md preview"]');
  const preview = page.frameLocator('iframe[title="README.md preview"]');

  await previewFrame.hover();
  await page.mouse.wheel(0, 1_200);
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeGreaterThan(150);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(50);
  await expect(cursorPosition).toHaveText(cursorBeforePreviewScroll ?? "0");
});

test("renders the Markdown outline and syncs through the real workspace layout", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-workspace", {
    waitUntil: "domcontentloaded",
  });

  await expect(
    page.getByTestId("markdown-workspace-harness-shell"),
  ).toBeVisible();
  await expect(page.getByTestId("markdown-preview")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Disable synchronized scrolling" }),
  ).toHaveAttribute("aria-pressed", "true");

  const preview = page.frameLocator('iframe[title="README.md preview"]');
  const previewFrame = page.locator('iframe[title="README.md preview"]');
  const editorScroller = page.locator(".cm-scroller");
  await expect(editorScroller).toBeVisible();
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeLessThan(20);

  await previewFrame.hover();
  await page.mouse.wheel(0, 1_200);
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeGreaterThan(150);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(50);

  await page.mouse.wheel(0, -2_000);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeLessThan(100);

  const outline = page.locator('[data-sidebar-section="outline"]');
  const outlineItems = outline.locator("[data-outline-line]");
  await expect(outlineItems).toHaveCount(8);
  await expect(outlineItems.first()).toHaveAttribute("data-outline-level", "1");
  await expect(outlineItems.first().locator("..")).toContainText("H1");
  await expect(outlineItems.first()).toContainText("Markdown Preview");

  const headingOffsets = await outlineItems.evaluateAll((items) =>
    items.slice(0, 3).map((item) => item.getBoundingClientRect().left),
  );
  expect(headingOffsets[1] - headingOffsets[0]).toBe(16);
  expect(headingOffsets[2] - headingOffsets[1]).toBe(16);
  const fileIcon = await page
    .locator('[data-sidebar-file-id="README.md"] [data-sidebar-row-icon]')
    .boundingBox();
  const headingIcon = await outlineItems
    .first()
    .locator("..")
    .locator("[data-sidebar-row-icon]")
    .boundingBox();
  expect(headingIcon!.x).toBe(fileIcon!.x);
  const headingToggle = outline.getByRole("button", {
    name: "Collapse Markdown Preview",
    exact: true,
  });
  await expect(headingToggle).toHaveText("H1");
  await expect(headingToggle.locator("svg")).toHaveCount(0);
  const toggleBounds = await headingToggle.boundingBox();
  const titleBounds = await outlineItems.first().boundingBox();
  expect(toggleBounds!.x + toggleBounds!.width).toBe(titleBounds!.x);
  const titleTextLeft = await outlineItems.first().evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().left;
  });
  expect(titleTextLeft - headingIcon!.x).toBe(28);
  const padding = await headingToggle.evaluate((el) => ({
    left: getComputedStyle(el).paddingLeft,
    right: getComputedStyle(el).paddingRight,
  }));
  expect(padding).toEqual({ left: "4px", right: "4px" });
  await headingToggle.hover();
  expect(
    await outlineItems
      .first()
      .locator("..")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
  expect(
    await headingToggle.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
  await outlineItems.first().hover();
  await expect
    .poll(() =>
      headingToggle.evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    .toBe("rgba(0, 0, 0, 0)");
  expect(
    await outlineItems
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");

  const readingNotesFoldButton = outline.getByRole("button", {
    name: "Collapse Reading notes",
  });
  const firstRow = outlineItems.first().locator("..");
  await expect(firstRow.locator("[data-outline-guide]")).toHaveCount(0);
  await expect(firstRow.locator("[data-outline-guide-start]")).toHaveCount(1);
  await expect(
    outlineItems.nth(2).locator("..").locator("[data-outline-guide]"),
  ).toHaveCount(2);
  const guide = await firstRow
    .locator("[data-outline-guide-start]")
    .boundingBox();
  expect(guide!.x + guide!.width / 2).toBe(
    headingIcon!.x + headingIcon!.width / 2,
  );
  const editorBeforeFold = await page
    .locator(".cm-line.cm-activeLine")
    .textContent();
  await readingNotesFoldButton.click();
  await expect(page.locator(".cm-line.cm-activeLine")).toHaveText(
    editorBeforeFold ?? "",
  );
  await expect(outlineItems).toHaveCount(2);
  await expect(outline.locator('[data-outline-guide="2"]')).toHaveCount(0);
  await expect(outline.locator('[data-outline-guide-start="2"]')).toHaveCount(
    0,
  );
  await outline.getByRole("button", { name: "Expand Reading notes" }).click();
  await expect(outlineItems).toHaveCount(8);

  const sectionFourOutlineItem = outlineItems.filter({
    hasText: "Section four",
  });
  await expect(sectionFourOutlineItem).toHaveAttribute(
    "data-outline-level",
    "3",
  );
  await sectionFourOutlineItem.click();
  const activeEditorLine = page.locator(".cm-line.cm-activeLine");
  await expect(activeEditorLine).toContainText("### Section four");
  await expect(activeEditorLine).toBeInViewport();
  await expect(sectionFourOutlineItem).toHaveAttribute(
    "aria-current",
    "location",
  );
  await outline.getByRole("button", { name: "Collapse Reading notes" }).click();
  await expect(
    outline.getByRole("button", { name: "Reading notes", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await expect(outline.locator('[aria-current="location"]')).toHaveCount(1);
  await outline.getByRole("button", { name: "Expand Reading notes" }).click();
  await expect(sectionFourOutlineItem).toHaveAttribute(
    "aria-current",
    "location",
  );

  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);

  await page.screenshot({
    path: "test-results/markdown-outline.png",
    fullPage: true,
  });
});

test("formats Markdown from the editor header and reports live text counts", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview", {
    waitUntil: "domcontentloaded",
  });

  const editorToolbar = page.getByTestId("markdown-editor-toolbar");
  const previewToolbar = page.getByTestId("markdown-preview-toolbar");
  await expect(editorToolbar).toBeVisible();
  await expect(previewToolbar).toBeVisible();
  await expect(page.getByTestId("markdown-word-count")).toHaveText(
    /^\d[\d,]* words$/,
  );
  await expect(page.getByTestId("markdown-character-count")).toHaveText(
    /^\d[\d,]* chars$/,
  );
  await expect(page.getByTestId("markdown-editor-statistics")).toContainText(
    /words\s*·\s*[\d,]+ chars/,
  );

  const [editorToolbarBox, previewToolbarBox] = await Promise.all([
    editorToolbar.boundingBox(),
    previewToolbar.boundingBox(),
  ]);
  expect(editorToolbarBox?.height).toBe(previewToolbarBox?.height);

  const firstLine = page.locator(".cm-line").first();
  await firstLine.click();
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "Bold" }).click();
  await expect(firstLine).toContainText("**text**# Markdown Preview");
  await expect(page.getByTestId("markdown-word-count")).toHaveText(
    /^1\/\d[\d,]* words$/,
  );
  await expect(page.getByTestId("markdown-character-count")).toHaveText(
    /^4\/\d[\d,]* chars$/,
  );

  await page.keyboard.press("Meta+z");
  await expect(firstLine).toHaveText("# Markdown Preview");

  const paragraph = page
    .locator(".cm-line")
    .filter({ hasText: "Markdown keeps source and preview close together" })
    .first();
  await paragraph.click();
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "Heading style" }).click();
  await page.getByRole("menuitem", { name: "Heading 2" }).click();
  await expect(paragraph).toContainText(
    "## Markdown keeps source and preview close together",
  );

  await page.getByRole("button", { name: "Heading style" }).click();
  await page.getByRole("menuitem", { name: "Paragraph" }).click();
  await expect(paragraph).toHaveText(
    "Markdown keeps source and preview close together while longer documents grow.",
  );
  await page.getByRole("button", { name: "Bulleted list" }).click();
  await expect(paragraph).toContainText(
    "- Markdown keeps source and preview close together",
  );

  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+End");
  await page.keyboard.press("Enter");
  const blankLine = page.locator(".cm-line").last();
  const cursorPosition = page.getByTestId("markdown-editor-cursor-position");
  const cursorBeforeList = Number(await cursorPosition.textContent());
  await page.getByRole("button", { name: "Bulleted list" }).click();
  await expect(blankLine).toHaveText("- ", { useInnerText: false });
  await expect(cursorPosition).toHaveText(String(cursorBeforeList + 2));
  await page.getByRole("button", { name: "Bulleted list" }).click();
  await expect(blankLine).toHaveText("", { useInnerText: false });
  await expect(cursorPosition).toHaveText(String(cursorBeforeList));
  await page.getByRole("button", { name: "Numbered list" }).click();
  await expect(blankLine).toHaveText("1. ", { useInnerText: false });
  await expect(cursorPosition).toHaveText(String(cursorBeforeList + 3));
  await page.getByRole("button", { name: "Checklist" }).click();
  await expect(blankLine).toHaveText("- [ ] ", { useInnerText: false });
  await expect(cursorPosition).toHaveText(String(cursorBeforeList + 6));
  await page.getByRole("button", { name: "Checklist" }).click();
  await expect(blankLine).toHaveText("", { useInnerText: false });
  await expect(cursorPosition).toHaveText(String(cursorBeforeList));

  await page.screenshot({
    path: "test-results/markdown-editor-toolbar.png",
    fullPage: true,
  });
});

test("renders Markdown live and applies project Typora themes", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview", {
    waitUntil: "domcontentloaded",
  });

  await expect(
    page.getByTestId("markdown-preview-harness-shell"),
  ).toBeVisible();
  await expect(page.getByTestId("markdown-preview")).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);

  const preview = page.frameLocator('iframe[title="README.md preview"]');
  await expect(
    preview.getByRole("heading", { name: "Markdown Preview" }),
  ).toBeVisible();
  await expect(preview.getByRole("table")).toBeVisible();
  await expect(preview.locator(".katex-display")).toBeVisible();
  await expect(
    preview.getByRole("heading", { name: "Section four" }),
  ).toHaveAttribute("data-markdown-source-start", /\d+/);

  const markdownToolbar = page.getByTestId("markdown-preview-toolbar");
  const themeSelect = page.getByRole("combobox", {
    name: "Markdown preview theme",
  });
  const themeIcon = themeSelect.getByTestId("markdown-theme-icon");
  const exportPdfButton = page.getByRole("button", {
    name: "Export Markdown as PDF",
  });
  await expect(themeIcon).toBeVisible();
  await expect(themeIcon).toHaveAttribute("data-theme-mode-icon", "light");
  await expect(themeSelect).toContainText("GitHub Light");
  await expect
    .poll(() =>
      preview
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgb(255, 255, 255)");
  await expect
    .poll(() =>
      markdownToolbar.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
      })),
    )
    .toEqual({
      background: "rgb(255, 255, 255)",
      color: "rgb(31, 35, 40)",
    });

  await themeSelect.click();
  await page.getByRole("option", { name: "GitHub Dark" }).click();
  await expect(themeSelect).toContainText("GitHub Dark");
  await expect
    .poll(() =>
      markdownToolbar.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
        colorScheme: getComputedStyle(element).colorScheme,
      })),
    )
    .toEqual({
      background: "rgb(13, 17, 23)",
      color: "rgb(230, 237, 243)",
      colorScheme: "dark",
    });
  await page.screenshot({
    path: "test-results/markdown-preview-github-dark-header.png",
    fullPage: true,
  });
  await themeSelect.click();
  await page.getByRole("option", { name: "GitHub Light" }).click();
  await expect(themeSelect).toContainText("GitHub Light");

  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(themeIcon).toHaveAttribute("data-theme-mode-icon", "dark");
  await expect(themeSelect).toContainText("GitHub Dark");
  await expect
    .poll(() =>
      preview
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgb(13, 17, 23)");
  await expect
    .poll(() =>
      markdownToolbar.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
      })),
    )
    .toEqual({
      background: "rgb(13, 17, 23)",
      color: "rgb(230, 237, 243)",
    });
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(themeIcon).toHaveAttribute("data-theme-mode-icon", "light");
  await expect(themeSelect).toContainText("GitHub Light");
  await page.getByRole("button", { name: "Use shared theme mode" }).click();
  await expect(themeIcon).toHaveAttribute("data-theme-mode-icon", "shared");
  await page.getByRole("button", { name: "Use separate theme mode" }).click();
  await expect(themeIcon).toHaveAttribute("data-theme-mode-icon", "light");
  await expect
    .poll(() =>
      markdownToolbar.evaluate((element) =>
        Math.round(element.getBoundingClientRect().height),
      ),
    )
    .toBe(48);
  const toolbarControlPositions = await markdownToolbar.evaluate((toolbar) => {
    const theme = toolbar.querySelector<HTMLElement>(
      '[aria-label="Markdown preview theme"]',
    );
    const exportButton = toolbar.querySelector<HTMLElement>(
      '[aria-label="Export Markdown as PDF"]',
    );
    if (!theme || !exportButton) return null;
    const toolbarRect = toolbar.getBoundingClientRect();
    const themeRect = theme.getBoundingClientRect();
    const exportRect = exportButton.getBoundingClientRect();
    return {
      themeLeft: themeRect.left - toolbarRect.left,
      exportRight: toolbarRect.right - exportRect.right,
      toolbarWidth: toolbarRect.width,
    };
  });
  expect(toolbarControlPositions).not.toBeNull();
  expect(toolbarControlPositions!.themeLeft).toBeLessThan(
    toolbarControlPositions!.toolbarWidth / 2,
  );
  expect(toolbarControlPositions!.exportRight).toBeLessThan(12);

  const themeSelectBox = await themeSelect.boundingBox();
  expect(themeSelectBox).not.toBeNull();
  await themeSelect.click();
  const themeMenu = page.locator('[data-slot="select-content"]');
  await expect(themeMenu).toBeVisible();
  await themeMenu.evaluate(async (menu) => {
    await Promise.allSettled(
      menu
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  const themeMenuBox = await themeMenu.boundingBox();
  expect(themeMenuBox).not.toBeNull();
  const themeMenuGap =
    themeMenuBox!.y - (themeSelectBox!.y + themeSelectBox!.height);
  expect(themeMenuGap).toBeGreaterThanOrEqual(4);
  await page.screenshot({
    path: "test-results/markdown-preview-theme-menu.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(themeMenu).toBeHidden();

  const previewFrame = page.locator('iframe[title="README.md preview"]');
  await expect(previewFrame).toHaveAttribute(
    "sandbox",
    "allow-popups allow-same-origin",
  );
  await page.evaluate(() => {
    type Invoke = (
      command: string,
      args?: unknown,
      options?: { headers?: Record<string, string> },
    ) => Promise<unknown>;
    const win = window as Window & {
      __TAURI_INTERNALS__?: { invoke?: Invoke };
      __markdownPdfExportHarness?: {
        appDisplay: string | null;
        byteLength: number;
        customThemeCssLoaded: boolean;
        heading: string | null;
        nativeAvailable: boolean;
        nativePath: string;
        path: string;
        prefix: string;
        previewTheme: string | null;
        printDisplay: string | null;
        themeCssLoaded: boolean;
      };
    };
    const originalInvoke = win.__TAURI_INTERNALS__?.invoke;
    if (!win.__TAURI_INTERNALS__ || !originalInvoke) {
      throw new Error("Tauri browser mocks are not ready");
    }
    const harness = {
      appDisplay: null,
      byteLength: 0,
      customThemeCssLoaded: false,
      heading: null,
      nativeAvailable: true,
      nativePath: "",
      path: "",
      prefix: "",
      previewTheme: null,
      printDisplay: null,
      themeCssLoaded: false,
    };
    win.__markdownPdfExportHarness = harness;
    win.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
      if (command === "plugin:dialog|save") return "/tmp/README.pdf";
      if (command === "export_markdown_pdf_native") {
        const printRoot = document.querySelector<HTMLElement>(
          "[data-catalex-markdown-pdf-root]",
        );
        const themeStyle = document.getElementById(
          "catalex-markdown-pdf-theme",
        );
        harness.appDisplay = document.getElementById("root")
          ? getComputedStyle(document.getElementById("root")!).display
          : null;
        harness.customThemeCssLoaded = Boolean(
          themeStyle?.textContent?.includes("rgb(35, 99, 235)"),
        );
        harness.heading = printRoot?.querySelector("h1")?.textContent ?? null;
        harness.nativePath = (args as { filePath?: string })?.filePath ?? "";
        harness.printDisplay = printRoot
          ? getComputedStyle(printRoot).display
          : null;
        harness.previewTheme = document.body.getAttribute("data-preview-theme");
        harness.themeCssLoaded = Boolean(
          themeStyle?.textContent?.includes("data-preview-theme"),
        );
        return harness.nativeAvailable;
      }
      if (command === "plugin:fs|write_file") {
        const bytes = args as Uint8Array;
        harness.byteLength = bytes.byteLength;
        harness.path = decodeURIComponent(options?.headers?.path ?? "");
        harness.prefix = new TextDecoder().decode(bytes.slice(0, 5));
        return null;
      }
      return originalInvoke(command, args, options);
    };
  });
  await expect(exportPdfButton).toBeEnabled();
  await page.emulateMedia({ media: "print" });
  await exportPdfButton.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const win = window as Window & {
          __markdownPdfExportHarness?: {
            appDisplay: string | null;
            byteLength: number;
            customThemeCssLoaded: boolean;
            heading: string | null;
            nativeAvailable: boolean;
            nativePath: string;
            path: string;
            prefix: string;
            previewTheme: string | null;
            printDisplay: string | null;
            themeCssLoaded: boolean;
          };
        };
        return win.__markdownPdfExportHarness?.nativePath ?? "";
      }),
    )
    .toBe("/tmp/README.pdf");
  const nativePdfExport = await page.evaluate(() => {
    const win = window as Window & {
      __markdownPdfExportHarness?: {
        appDisplay: string | null;
        byteLength: number;
        customThemeCssLoaded: boolean;
        heading: string | null;
        nativeAvailable: boolean;
        nativePath: string;
        path: string;
        prefix: string;
        previewTheme: string | null;
        printDisplay: string | null;
        themeCssLoaded: boolean;
      };
    };
    return win.__markdownPdfExportHarness;
  });
  expect(nativePdfExport).toMatchObject({
    appDisplay: "none",
    byteLength: 0,
    customThemeCssLoaded: false,
    heading: "Markdown Preview",
    nativePath: "/tmp/README.pdf",
    path: "",
    prefix: "",
    previewTheme: "github",
    printDisplay: "block",
    themeCssLoaded: true,
  });
  await page.emulateMedia({ media: "screen" });
  await expect(page.locator("[data-catalex-markdown-pdf-root]")).toHaveCount(0);
  await expect(exportPdfButton).toBeEnabled();

  await page.evaluate(() => {
    const harness = (
      window as Window & {
        __markdownPdfExportHarness?: {
          nativeAvailable: boolean;
          prefix: string;
        };
      }
    ).__markdownPdfExportHarness;
    if (!harness) throw new Error("PDF export harness is unavailable");
    harness.nativeAvailable = false;
    harness.prefix = "";
  });
  await exportPdfButton.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __markdownPdfExportHarness?: { prefix: string };
            }
          ).__markdownPdfExportHarness?.prefix ?? "",
      ),
    )
    .toBe("%PDF-");
  const fallbackPdfExport = await page.evaluate(() => {
    const win = window as Window & {
      __markdownPdfExportHarness?: {
        byteLength: number;
        path: string;
      };
    };
    return win.__markdownPdfExportHarness;
  });
  expect(fallbackPdfExport?.path).toBe("/tmp/README.pdf");
  expect(fallbackPdfExport?.byteLength).toBeGreaterThan(1_000);
  await expect(exportPdfButton).toBeEnabled();

  const locatePreviewButton = page.getByRole("button", {
    name: "Locate preview position",
  });
  const locateEditorButton = page.getByRole("button", {
    name: "Locate editor position",
  });
  const scrollSyncLockButton = page.getByRole("button", {
    name: "Disable synchronized scrolling",
  });
  await expect(scrollSyncLockButton).toHaveAttribute("aria-pressed", "true");
  await expect(locatePreviewButton).toBeHidden();
  await expect(locateEditorButton).toBeHidden();

  const editorScroller = page.locator(".cm-scroller");
  const cursorBeforeLockedScroll = await page
    .getByTestId("markdown-editor-cursor-position")
    .textContent();
  await editorScroller.evaluate((element) => {
    const maxScrollTop = element.scrollHeight - element.clientHeight;
    element.scrollTop = maxScrollTop * 0.6;
  });
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeGreaterThan(200);
  await page.waitForTimeout(500);

  await page.screenshot({
    path: "test-results/markdown-preview-locked-editor-to-preview.png",
    fullPage: true,
  });

  await editorScroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeLessThan(1);
  await page.waitForTimeout(500);

  await editorScroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      preview.locator("html").evaluate(() => {
        const scrollingElement = document.scrollingElement;
        if (!scrollingElement) return Number.POSITIVE_INFINITY;
        const maxScrollTop = Math.max(
          0,
          scrollingElement.scrollHeight - scrollingElement.clientHeight,
        );
        return maxScrollTop - scrollingElement.scrollTop;
      }),
    )
    .toBeLessThan(1);
  await page.waitForTimeout(500);

  await editorScroller.evaluate((element) => {
    const maxScrollTop = element.scrollHeight - element.clientHeight;
    element.scrollTop = maxScrollTop * 0.6;
  });
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeGreaterThan(200);

  await page.waitForTimeout(150);
  await previewFrame.hover();
  await page.mouse.wheel(0, -2_000);
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeLessThan(50);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeLessThan(100);

  await page.mouse.wheel(0, 900);
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeGreaterThan(100);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(50);
  const previewCenterSourcePosition = await preview
    .locator("body")
    .evaluate(() => {
      const selector = "[data-markdown-source-start]";
      const viewport = document.documentElement;
      const centerY = viewport.clientHeight / 2;
      const target = document.elementFromPoint(
        viewport.clientWidth / 2,
        centerY,
      );
      const direct = target?.closest<HTMLElement>(selector);
      if (direct) return direct.dataset.markdownSourceStart ?? null;

      let closest: { position: string; distance: number } | null = null;
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > viewport.clientHeight) continue;
        const position = element.dataset.markdownSourceStart;
        if (!position) continue;
        const distance = Math.abs(rect.top + rect.height / 2 - centerY);
        if (!closest || distance < closest.distance) {
          closest = { position, distance };
        }
      }
      return closest?.position ?? null;
    });
  expect(previewCenterSourcePosition).toMatch(/^\d+$/);
  await expect(page.getByTestId("markdown-editor-cursor-position")).toHaveText(
    cursorBeforeLockedScroll ?? "0",
  );

  await page.mouse.wheel(0, -2_000);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeLessThan(100);

  await page.screenshot({
    path: "test-results/markdown-preview-locked-sync.png",
    fullPage: true,
  });

  await scrollSyncLockButton.click();
  await expect(
    page.getByRole("button", { name: "Enable synchronized scrolling" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(locatePreviewButton).toBeEnabled();
  await expect(locateEditorButton).toBeEnabled();

  await editorScroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(200);
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBe(0);

  await page.screenshot({
    path: "test-results/markdown-preview-github.png",
    fullPage: true,
  });

  await locatePreviewButton.click();
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeGreaterThan(200);
  await expect
    .poll(() =>
      preview
        .getByRole("heading", { name: "Sync destination" })
        .evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2);
        }),
    )
    .toBeLessThan(180);

  const centerSourcePosition = await preview.locator("body").evaluate(() => {
    const target = document.elementFromPoint(
      document.documentElement.clientWidth / 2,
      document.documentElement.clientHeight / 2,
    );
    return target
      ?.closest("[data-markdown-source-start]")
      ?.getAttribute("data-markdown-source-start");
  });
  expect(centerSourcePosition).toMatch(/^\d+$/);
  await locateEditorButton.click();
  await expect(page.getByTestId("markdown-editor-cursor-position")).toHaveText(
    centerSourcePosition!,
  );
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);

  const doubleClickHeading = preview.getByRole("heading", {
    name: "Section four",
  });
  const doubleClickSourcePosition = await doubleClickHeading.getAttribute(
    "data-markdown-source-start",
  );
  expect(doubleClickSourcePosition).toMatch(/^\d+$/);
  // Manual scrolling interrupts the still-running Locate editor animation.
  await editorScroller.hover();
  await page.mouse.wheel(0, -10_000);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBe(0);
  await doubleClickHeading.dblclick();
  await expect(page.getByTestId("markdown-editor-cursor-position")).toHaveText(
    doubleClickSourcePosition!,
  );
  const activeEditorLine = page.locator(".cm-line.cm-activeLine");
  await expect(activeEditorLine).toContainText("### Section four");
  await expect(activeEditorLine).toBeInViewport();
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);

  await page.screenshot({
    path: "test-results/markdown-preview-sync.png",
    fullPage: true,
  });

  await preview.locator("html").evaluate(() => {
    const style = document.querySelector("#catalex-markdown-preview-style");
    const math = document.querySelector<HTMLElement>(".katex-display .katex");
    if (!style || !math) throw new Error("Markdown math preview is not ready");
    math.dataset.renderIdentity = "before-edit";
    document.documentElement.dataset.previewStyleMutations = "0";
    const observer = new MutationObserver(() => {
      const currentCount = Number(
        document.documentElement.dataset.previewStyleMutations ?? "0",
      );
      document.documentElement.dataset.previewStyleMutations = String(
        currentCount + 1,
      );
    });
    observer.observe(style, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await page.getByRole("button", { name: "Update content" }).click();
  await expect(
    preview.getByRole("heading", { name: "Updated Preview" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  const liveRenderStability = await preview.locator("html").evaluate(() => ({
    mathNodePreserved: Boolean(
      document.querySelector('.katex[data-render-identity="before-edit"]'),
    ),
    styleMutations: Number(
      document.documentElement.dataset.previewStyleMutations ?? "0",
    ),
  }));
  expect(liveRenderStability).toEqual({
    mathNodePreserved: true,
    styleMutations: 0,
  });

  await page.getByRole("combobox", { name: "Markdown preview theme" }).click();
  await page.getByRole("option", { name: "themes/academic.css" }).click();
  await expect
    .poll(() =>
      preview
        .locator("h1")
        .evaluate((element) => getComputedStyle(element).color),
    )
    .toBe("rgb(126, 58, 47)");

  await page
    .getByRole("button", { name: "Use configured Typora theme" })
    .click();
  await expect
    .poll(() =>
      preview
        .locator("h1")
        .evaluate((element) => getComputedStyle(element).color),
    )
    .toBe("rgb(35, 99, 235)");
  await expect(themeSelect).toContainText("Academic");
  await expect
    .poll(() =>
      preview.locator("body").evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
        appColorScheme: element.getAttribute("data-color-scheme"),
      })),
    )
    .toEqual({
      background: "rgb(248, 250, 252)",
      color: "rgb(23, 37, 84)",
      appColorScheme: null,
    });

  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(themeSelect).toContainText("Academic");
  await expect
    .poll(() =>
      preview.locator("body").evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
        appColorScheme: element.getAttribute("data-color-scheme"),
      })),
    )
    .toEqual({
      background: "rgb(248, 250, 252)",
      color: "rgb(23, 37, 84)",
      appColorScheme: null,
    });
  await expect
    .poll(() =>
      markdownToolbar.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
      })),
    )
    .toEqual({
      background: "rgb(248, 250, 252)",
      color: "rgb(23, 37, 84)",
    });

  await page
    .getByRole("button", { name: "Disable Typora theme loading" })
    .click();
  await expect(themeSelect).toContainText("GitHub Dark");
  await expect
    .poll(() =>
      preview
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgb(13, 17, 23)");

  await page
    .getByRole("button", { name: "Enable Typora theme loading" })
    .click();
  await expect(themeSelect).toContainText("Academic");
  await expect
    .poll(() =>
      preview
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgb(248, 250, 252)");

  await page.evaluate(() => {
    const harness = (
      window as Window & {
        __markdownPdfExportHarness?: {
          byteLength: number;
          customThemeCssLoaded: boolean;
          nativeAvailable: boolean;
          nativePath: string;
        };
      }
    ).__markdownPdfExportHarness;
    if (!harness) throw new Error("PDF export harness is unavailable");
    harness.byteLength = 0;
    harness.customThemeCssLoaded = false;
    harness.nativeAvailable = true;
    harness.nativePath = "";
  });
  await page.emulateMedia({ media: "print" });
  await exportPdfButton.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __markdownPdfExportHarness?: {
                customThemeCssLoaded: boolean;
                nativePath: string;
              };
            }
          ).__markdownPdfExportHarness,
      ),
    )
    .toMatchObject({
      customThemeCssLoaded: true,
      nativePath: "/tmp/README.pdf",
    });
  const typoraNativeExport = await page.evaluate(() => {
    const harness = (
      window as Window & {
        __markdownPdfExportHarness?: {
          byteLength: number;
          previewTheme: string | null;
          printDisplay: string | null;
        };
      }
    ).__markdownPdfExportHarness;
    return harness;
  });
  expect(typoraNativeExport).toMatchObject({
    byteLength: 0,
    previewTheme: "typora",
    printDisplay: "block",
  });
  await page.emulateMedia({ media: "screen" });
  await expect(exportPdfButton).toBeEnabled();

  await page.screenshot({
    path: "test-results/markdown-preview-harness.png",
    fullPage: true,
  });
});

test("outline follows editor scrolling without moving the cursor", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-workspace", {
    waitUntil: "domcontentloaded",
  });
  const outline = page.locator('[data-sidebar-section="outline"]');
  await expect(outline.locator('[aria-current="location"]')).toBeVisible();
  const initialHeading = await outline
    .locator('[aria-current="location"]')
    .textContent();
  const cursorPosition = () =>
    page.evaluate(async () => {
      const modulePath = "/src/renderer/stores/document-store.ts";
      return (await import(modulePath)).useDocumentStore.getState()
        .cursorPosition;
    });
  const initialCursor = await cursorPosition();
  const scroller = page.locator(".cm-scroller");
  await scroller.hover();
  await page.mouse.wheel(0, 700);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(300);
  await expect
    .poll(() => outline.locator('[aria-current="location"]').textContent())
    .not.toBe(initialHeading);
  expect(await cursorPosition()).toBe(initialCursor);
  const sectionThree = page
    .locator(".cm-line")
    .filter({ hasText: "### Section three" });
  await sectionThree.click({ position: { x: 60, y: 8 } });
  await expect(outline.locator('[aria-current="location"]')).toHaveText(
    "Section three",
  );
  // Allow the editor to finish revealing the clicked caret before measuring scrolling.
  await page.waitForTimeout(300);
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
  await scroller.hover();
  await page.mouse.wheel(0, 40);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(scrollBefore);
  await expect
    .poll(() => outline.locator('[aria-current="location"]').textContent())
    .not.toBe("Section three");
  // Re-click the same caret after scrolling; it must reclaim the highlight even without a selection change.
  await sectionThree.click({ position: { x: 60, y: 8 } });
  await page.waitForTimeout(300);
  await expect(outline.locator('[aria-current="location"]')).toHaveText(
    "Section three",
  );
  await page.screenshot({
    path: "test-results/outline-scroll-highlight.png",
    fullPage: true,
  });
  await page.mouse.wheel(0, -3000);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(outline.locator('[aria-current="location"]')).toHaveText(
    initialHeading!,
  );
});
