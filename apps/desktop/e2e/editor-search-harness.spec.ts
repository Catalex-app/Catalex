import { expect, type Locator, test } from "@playwright/test";

async function trackBarTransitions(motion: Locator) {
  return motion.evaluateHandle((element) => {
    const openings: string[] = [];
    element.addEventListener("transitionrun", (event) => {
      if (event.target === element && event.propertyName === "height") {
        openings.push(element.dataset.open!);
      }
    });
    return openings;
  });
}

test("editor search harness supports VS Code style search controls @core", async ({
  page,
}) => {
  await page.goto("/?debug=editor-search", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-search-harness-shell")).toBeVisible();
  const searchInput = page.getByPlaceholder("Search...");
  await expect(searchInput).toBeVisible();

  await expect(page.getByText("1/3")).toBeVisible();

  await page.getByRole("button", { name: "Match Case", exact: true }).click();
  await expect(page.getByText("1/2")).toBeVisible();

  await searchInput.fill("word");
  await expect(page.getByText("1/4")).toBeVisible();
  await page
    .getByRole("button", { name: "Match Whole Word", exact: true })
    .click();
  await expect(page.getByText("1/2")).toBeVisible();

  await page.getByRole("button", { name: "Use Regex", exact: true }).click();
  await searchInput.fill("[");
  await expect(page.getByText("Invalid regex")).toBeVisible();

  await searchInput.fill("Search");
  await expect(page.getByText("1/2")).toBeVisible();

  const findField = page.getByRole("group", { name: "Search options" });
  const expandReplace = findField.getByRole("button", {
    name: "Toggle Replace",
  });
  const chevron = (await expandReplace.boundingBox())!;
  const matchCase = (await findField
    .getByRole("button", { name: "Match Case" })
    .boundingBox())!;
  const findInputLeft = (await searchInput.boundingBox())!.x;
  expect(chevron.width).toBe(matchCase.width);
  expect(chevron.height).toBe(matchCase.height);
  expect(findInputLeft - chevron.x - chevron.width).toBe(4);
  await expect(searchInput).toHaveCSS("padding-left", "0px");
  await page.screenshot({
    path: test.info().outputPath("replace-collapsed.png"),
  });
  await expandReplace.click();
  await expect(expandReplace).toHaveCount(0);
  const replaceField = page.getByRole("group", { name: "Replace options" });
  const replaceInput = replaceField.getByPlaceholder("Replace...");
  const collapseReplace = replaceField.getByRole("button", {
    name: "Collapse Replace",
  });
  await expect(replaceInput).toBeVisible();
  await expect(replaceInput).toHaveCSS("padding-left", "0px");
  expect((await collapseReplace.boundingBox())!.x).toBeLessThan(
    (await replaceInput.boundingBox())!.x,
  );
  expect((await replaceInput.boundingBox())!.x).toBe(findInputLeft);
  expect((await searchInput.boundingBox())!.x).toBe(findInputLeft);
  await page.screenshot({
    path: test.info().outputPath("replace-expanded.png"),
  });
  await collapseReplace.click();
  await expect(replaceField).toHaveCount(0);
  await expandReplace.click();
  await page.getByPlaceholder("Replace...").fill("Locate");
  await page.getByRole("button", { name: "Replace All" }).click();
  await expect(page.getByTestId("harness-document")).not.toContainText(
    "Search",
  );

  const findInSelectionButton = findField.getByRole("button", {
    name: "Find in Selection",
  });
  await expect(findInSelectionButton).toBeDisabled();
  await page.getByTestId("selection-toggle").click();
  await expect(findInSelectionButton).toBeEnabled();
  await findInSelectionButton.click();
  await expect(findInSelectionButton).toHaveAttribute("aria-pressed", "true");
  await findInSelectionButton.click();

  await searchInput.fill("Locate");
  await page.keyboard.press("ArrowUp");
  await expect(searchInput).toHaveValue("Search");

  await page.screenshot({
    path: "test-results/editor-search-harness.png",
    fullPage: true,
  });
});

test("real editor search fits narrow panes, keeps focus, and restores the query", async ({
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
  const panel = page.getByTestId("editor-search-panel");
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  const close = panel.getByRole("button", { name: "Close", exact: true });
  const motion = page.locator('[data-problems-motion="bar"]').filter({
    has: panel,
  });
  async function expectUnclippedBar() {
    await expect
      .poll(() =>
        motion.evaluate((bar) => {
          const bounds = bar.getBoundingClientRect();
          const content = bar.querySelector(".problems-motion-content")!;
          const panel = content.querySelector(
            '[data-testid="editor-search-panel"]',
          )!;
          const rowsVisible = Array.from(panel.children).every((row) => {
            const rowBounds = row.getBoundingClientRect();
            return (
              rowBounds.top >= bounds.top && rowBounds.bottom <= bounds.bottom
            );
          });
          return {
            measuredHeight:
              bounds.height === content.getBoundingClientRect().height,
            rowsVisible,
            scrollTop: bar.scrollTop,
          };
        }),
      )
      .toEqual({ measuredHeight: true, rowsVisible: true, scrollTop: 0 });
  }
  for (const width of [1600, 1000]) {
    await page.setViewportSize({ width, height: 720 });
    await content.focus();
    await page.keyboard.press("ControlOrMeta+f");
    await expect(input).toBeFocused();
    if (width === 1000) await expect(input).toHaveValue("Source context 49");
    await input.fill("Source context 49");
    await input.press("Enter");
    await expect(input).toBeFocused();
    await expect(page.locator(".cm-scroller")).toBeVisible();
    await panel.evaluate(async (element) => {
      const motion = element.closest('[data-problems-motion="bar"]');
      await Promise.allSettled(
        motion
          ?.getAnimations({ subtree: true })
          .filter((animation) => animation instanceof CSSTransition)
          .map((animation) => animation.finished) ?? [],
      );
    });
    const options = panel.getByRole("group", { name: "Search options" });
    expect((await input.boundingBox())!.height).toBe(
      (await options.boundingBox())!.height,
    );
    const bar = (await panel.boundingBox())!;
    const scroller = (await page.locator(".cm-scroller").boundingBox())!;
    const button = (await close.boundingBox())!;
    expect(bar.y + bar.height).toBeLessThanOrEqual(scroller.y + 1);
    expect(button.x + button.width).toBeLessThanOrEqual(bar.x + bar.width);
    await page.screenshot({ path: info.outputPath(`search-${width}.png`) });

    await panel.getByRole("button", { name: "Toggle Replace" }).click();
    const replace = panel.getByPlaceholder("Replace...");
    await expect(replace).toBeFocused();
    await expectUnclippedBar();
    expect((await motion.boundingBox())!.height).toBeGreaterThan(bar.height);
    await panel.getByRole("button", { name: "Collapse Replace" }).click();
    await expect(replace).toHaveCount(0);
    await expect(input).toBeFocused();
    await expectUnclippedBar();
    expect((await motion.boundingBox())!.height).toBe(bar.height);

    await close.click();
    await expect(panel).toHaveCount(0);
    await expect(content).toBeFocused();
  }
});

test("real editor search shows the toolbar for mouse and keyboard selections only", async ({
  page,
}, info) => {
  await page.goto("/?debug=editor-comments");
  await page.waitForFunction(() => window.__editorCommentsHarness?.ready);
  const content = page.locator(".cm-content");
  const panel = page.getByTestId("editor-search-panel");
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  const toolbar = page.locator("[data-selection-toolbar]");
  const match = (index: number) =>
    panel.getByRole("status", { name: `Match ${index} of 40`, exact: true });

  await content.focus();
  await page.keyboard.press("ControlOrMeta+f");
  await input.fill("Harness line");
  await expect(match(1)).toBeVisible();
  await expect(toolbar).toHaveCount(0);

  await input.press("Enter");
  await expect(match(2)).toBeVisible();
  await expect(input).toBeFocused();
  await expect(toolbar).toHaveCount(0);

  await panel.getByRole("button", { name: "Find Next", exact: true }).click();
  await expect(match(3)).toBeVisible();
  await expect(toolbar).toHaveCount(0);
  await panel
    .getByRole("button", { name: "Find Previous", exact: true })
    .click();
  await expect(match(2)).toBeVisible();
  await expect(toolbar).toHaveCount(0);

  await content.focus();
  await expect(toolbar).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(toolbar).toBeVisible();
  await expect(panel).toBeVisible();

  await input.press("Enter");
  await expect(match(3)).toBeVisible();
  await expect(input).toBeFocused();
  await expect(toolbar).toHaveCount(0);
  const { start, end } = await page.evaluate(
    () => window.__editorCommentsHarness!.coordsForText!("Harness line 4")!,
  );
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();

  await expect(toolbar).toBeVisible();
  await toolbar.hover();
  await expect(
    toolbar.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible();
  await expect(panel).toBeVisible();
  const searchBox = (await panel.boundingBox())!;
  const toolbarBox = (await toolbar.boundingBox())!;
  expect(toolbarBox.y).toBeGreaterThanOrEqual(searchBox.y + searchBox.height);
  await page.screenshot({
    path: info.outputPath("editor-selection-with-search-open.png"),
    animations: "disabled",
  });

  await input.press("Enter");
  await expect(match(5)).toBeVisible();
  await panel.getByRole("button", { name: "Toggle Replace" }).click();
  await panel.getByPlaceholder("Replace...").fill("Updated line");
  await panel.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(content).toContainText("Updated line 5");
  await expect(content).toBeFocused();
  await expect(toolbar).toHaveCount(0);
});

test("editor search lets a comment click open its bubble", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "catalex-harness-comments:/tmp/comment-harness",
      JSON.stringify({
        "main.tex": [
          {
            id: "search-comment",
            number: 1,
            from: 145,
            to: 159,
            line: 9,
            text: "Check this heading",
          },
        ],
      }),
    );
  });
  await page.goto("/?debug=editor-comments");
  const card = page.locator(".cm-inlineCommentCard");
  await expect(card).toContainText("Check this heading");
  const content = page.locator(".cm-content");
  const panel = page.getByTestId("editor-search-panel");
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  const bubble = page.locator("[data-selection-toolbar]");

  await content.focus();
  await page.keyboard.press("ControlOrMeta+f");
  await input.fill("Check this heading");
  await expect(panel.getByRole("status")).toHaveText("0/1");
  await input.press("Enter");
  await expect(panel.getByRole("status")).toHaveText("1/1");
  await expect(input).toBeFocused();
  await expect(bubble).toHaveCount(0);

  await input.fill("Harness line");
  await expect(panel.getByRole("status")).toHaveText("1/40");
  await expect(bubble).toHaveCount(0);
  await page.getByRole("button", { name: "Scroll to comment H-1" }).click();
  await expect(bubble).toBeVisible();
  await bubble.hover();
  await expect(
    bubble.getByRole("button", { name: "Set color to Yellow", exact: true }),
  ).toBeVisible();
  await expect(panel).toBeVisible();
  await page.screenshot({
    path: info.outputPath("comment-bubble-with-search.png"),
    animations: "disabled",
  });

  const scroller = page.locator(".cm-scroller");
  const searchEditorTop = (await scroller.boundingBox())!.y;
  const showComments = page.getByRole("button", { name: /^Show comments:/ });
  await showComments.click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator("[data-comments-panel]")).toBeVisible();
  expect((await scroller.boundingBox())!.y).toBe(searchEditorTop);

  await page.keyboard.press("ControlOrMeta+f");
  await expect(input).toBeFocused();
  const motion = page.locator('[data-problems-motion="bar"]');
  const transitions = await trackBarTransitions(motion);
  await panel.getByRole("button", { name: "Toggle Replace" }).click();
  await expect(motion).toHaveCSS("height", "96px");
  await showComments.click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator("[data-comments-panel]")).toBeVisible();
  await expect.poll(() => transitions.jsonValue()).toEqual(["true", "true"]);
  await expect(motion).toHaveCSS("height", "48px");
});

test("editor search slides in and out using the shared bar motion", async ({
  page,
}, info) => {
  await page.goto("/?debug=editor-comments");
  await page.waitForFunction(() => window.__editorCommentsHarness?.ready);
  const content = page.locator(".cm-content");
  const motion = page.locator('[data-problems-motion="bar"]');
  const panel = page.getByTestId("editor-search-panel");
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  const transitions = await trackBarTransitions(motion);

  await expect(motion).toHaveAttribute("data-open", "false");
  await expect(motion).toHaveCSS("height", "0px");
  await page.screenshot({ path: info.outputPath("search-before-open.png") });
  await content.focus();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(motion).toHaveAttribute("data-open", "true");
  await expect(input).toBeFocused();
  await expect.poll(() => transitions.jsonValue()).toEqual(["true"]);
  await expect(motion).toHaveCSS("height", "48px");
  await page.screenshot({ path: info.outputPath("search-open.png") });

  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(motion).toHaveAttribute("data-open", "false");
  await expect(content).toBeFocused();
  await expect.poll(() => transitions.jsonValue()).toEqual(["true", "false"]);
  await expect(motion).toHaveCSS("height", "0px");
  await expect(panel).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("search-after-close.png") });
});
