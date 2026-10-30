import { expect, test } from "@playwright/test";

test("editor search harness supports VS Code style search controls", async ({
  page,
}) => {
  await page.goto("/?debug=editor-search", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-search-harness-shell")).toBeVisible();
  const searchInput = page.getByPlaceholder("Search...");
  await expect(searchInput).toBeVisible();

  const panelWidth = await page
    .getByTestId("editor-search-panel")
    .evaluate((panel) => Math.round(panel.getBoundingClientRect().width));
  expect(panelWidth).toBeGreaterThan(740);
  expect(panelWidth).toBeLessThanOrEqual(860);

  await expect(page.getByText("1 of 3")).toBeVisible();

  await page.getByRole("button", { name: "Match Case", exact: true }).click();
  await expect(page.getByText("1 of 2")).toBeVisible();

  await searchInput.fill("word");
  await expect(page.getByText("1 of 4")).toBeVisible();
  await page
    .getByRole("button", { name: "Match Whole Word", exact: true })
    .click();
  await expect(page.getByText("1 of 2")).toBeVisible();

  await page.getByRole("button", { name: "Use Regex", exact: true }).click();
  await searchInput.fill("[");
  await expect(page.getByText("Invalid regex")).toBeVisible();

  await searchInput.fill("Search");
  await expect(page.getByText("1 of 2")).toBeVisible();

  await page
    .getByRole("button", { name: "Toggle Replace", exact: true })
    .click();
  await expect(page.getByPlaceholder("Replace...")).toBeVisible();
  await page.getByPlaceholder("Replace...").fill("Locate");
  await page.getByRole("button", { name: "Replace All" }).click();
  await expect(page.getByTestId("harness-document")).not.toContainText(
    "Search",
  );

  const findInSelectionButton = page.getByRole("button", {
    name: "In Selection",
  });
  await expect(findInSelectionButton).toBeDisabled();
  await page.getByTestId("selection-toggle").click();
  await expect(findInSelectionButton).toBeEnabled();

  await searchInput.fill("Locate");
  await page.keyboard.press("ArrowUp");
  await expect(searchInput).toHaveValue("Search");

  await page.screenshot({
    path: "test-results/editor-search-harness.png",
    fullPage: true,
  });
});

test("real editor reuses search spacing rules across reopening and viewport sizes", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?debug=pdf-comments&performance");
  await expect(
    page.locator('[data-page-number="1"] .mupdf-text-layer'),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit commented source", exact: true })
    .click();
  const content = page.locator(".cm-content");
  await expect(content).toContainText("Source context");
  const metrics = () =>
    page.evaluate(async () => {
      const { EditorView } = await import(
        "/node_modules/.vite/deps/@codemirror_view.js"
      );
      const view = EditorView.findFromDOM(
        document.querySelector(".cm-content")!,
      )!;
      const selection = view.state.selection.main;
      const rect = view.coordsAtPos(selection.from);
      const scroll = view.scrollDOM.getBoundingClientRect();
      return {
        doc: view.state.doc.toString(),
        top: getComputedStyle(view.contentDOM).paddingTop,
        bottom: getComputedStyle(view.contentDOM).paddingBottom,
        height: view.scrollDOM.clientHeight,
        topVariable: view.dom.style.getPropertyValue(
          "--catalex-search-padding-top",
        ),
        bottomVariable: view.dom.style.getPropertyValue(
          "--catalex-search-padding-bottom",
        ),
        selected: view.state.sliceDoc(selection.from, selection.to),
        selectionVisible:
          !!rect && rect.top >= scroll.top && rect.bottom <= scroll.bottom,
        rules: [...document.styleSheets]
          .filter((sheet) => !sheet.href)
          .reduce((sum, sheet) => sum + sheet.cssRules.length, 0),
      };
    });
  const before = await metrics();
  let ruleCount: number | undefined;
  for (const height of [1000, 700, 1000, 700, 1000, 700]) {
    await page.setViewportSize({ width: 1600, height });
    await content.focus();
    await page.keyboard.press("ControlOrMeta+f");
    const input = page.getByPlaceholder("Search...", { exact: true });
    await expect(input).toBeVisible();
    await expect.poll(async () => (await metrics()).topVariable).not.toBe("");
    const open = await metrics();
    expect(parseFloat(open.top)).toBeCloseTo(
      Math.min(open.height * 0.18, 140),
      1,
    );
    expect(parseFloat(open.bottomVariable)).toBeCloseTo(
      Math.min(open.height * 0.22, 180),
      1,
    );
    // scrollPastEnd owns inline bottom padding; search must keep that precedence.
    expect(parseFloat(open.bottom)).toBeGreaterThan(0);
    ruleCount ??= open.rules;
    expect(open.rules).toBe(ruleCount);
    await input.fill("Source context 49");
    await page.getByRole("button", { name: "Find Next", exact: true }).click();
    await expect
      .poll(async () => (await metrics()).selected)
      .toBe("Source context 49");
    await expect
      .poll(async () => (await metrics()).selectionVisible)
      .toBe(true);
    await input.press("Escape");
    await expect(input).toBeHidden();
    const closed = await metrics();
    expect(closed.topVariable).toBe("");
    expect(closed.bottomVariable).toBe("");
    expect(closed.top).toBe(before.top);
    expect(closed.doc).toBe(before.doc);
    expect(closed.rules).toBe(ruleCount);
  }
  await page.screenshot({ path: info.outputPath("search-closed.png") });
});
