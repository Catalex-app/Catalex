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

  const findInSelectionButton = page.getByRole("button", {
    name: "Find in Selection",
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
    await close.click();
    await expect(panel).toHaveCount(0);
    await expect(content).toBeFocused();
  }
});
