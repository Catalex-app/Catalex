import { expect, test } from "@playwright/test";

test("creates a Markdown preview comment, syncs it to the editor, and restores it", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview");
  const preview = page.frameLocator('iframe[title="README.md preview"]');
  const text = preview.locator("strong [data-comment-start]");
  await expect(text).toHaveText("GitHub-flavored Markdown");
  await text.evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element.firstChild!);
    const selection = element.ownerDocument.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
  // Split view owns one draft input in the source editor, just like PDF comments.
  const input = page.getByRole("textbox", {
    name: "Comment text",
    exact: true,
  });
  await expect(input).toHaveCount(1);
  await expect(input).toBeFocused();
  await expect(card).toHaveCount(0);
  await input.fill("Check this Markdown phrase");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".cm-editor")).toContainText(
    "Check this Markdown phrase",
  );
  const stored = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem(
        "catalex-harness-comments:/tmp/markdown-preview-harness",
      ) ?? "{}",
    ),
  );
  expect(stored["README.md"][0]).toMatchObject({
    from: 27,
    to: 51,
    text: "Check this Markdown phrase",
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-pdf-comment-highlight]")).toBeVisible();
  await preview.locator("strong").click();
  await expect(page.getByTestId("pdf-comment-focus-box")).toBeVisible();
  await expect(card).toHaveCount(0);
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  // The toolbar click dismisses focus; open the comment in preview-only view.
  await preview.locator("strong").click();
  await expect(card).toContainText("Check this Markdown phrase");
  await expect(card).toHaveCSS("opacity", "1");
  const focus = page.getByTestId("pdf-comment-focus-box");
  await expect(focus).toHaveCSS("outline-style", "dashed");
  await expect(page.locator("[data-pdf-comment-highlight]")).toHaveClass(
    /border-amber-500/,
  );
  await expect
    .poll(async () => {
      const box = await focus.boundingBox();
      const popup = await card.boundingBox();
      return Math.round(popup!.y - box!.y - box!.height);
    })
    .toBe(8);
  await expect(card.locator('[aria-label="Close comment"]')).toHaveCount(0);
  await page.screenshot({ path: "test-results/markdown-comment-light.png" });
  await preview
    .getByRole("heading", { name: "Markdown Preview", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await preview.locator("strong").click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Edit comment", exact: true }).click();
  await card
    .getByPlaceholder("Write a comment...")
    .fill("Updated preview comment");
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(card).toContainText("Updated preview comment");
  await page
    .getByRole("button", { name: "Switch to dark mode", exact: true })
    .click();
  await expect(page.getByTestId("markdown-preview")).toHaveCSS(
    "background-color",
    "rgb(13, 17, 23)",
  );
  await preview.locator("strong").click();
  await expect(card).toHaveCSS("opacity", "1");
  await expect
    .poll(async () => {
      const box = await focus.boundingBox();
      const textBox = await preview.locator("strong").boundingBox();
      return box && textBox ? Math.abs(box.y - textBox.y) : 100;
    })
    .toBeLessThan(2);
  await expect
    .poll(async () => {
      const box = await focus.boundingBox();
      const popup = await card.boundingBox();
      return Math.round(popup!.y - box!.y - box!.height);
    })
    .toBe(8);
  await page.screenshot({ path: "test-results/markdown-comment-dark.png" });
  await card
    .getByRole("button", { name: "Resolve comment", exact: true })
    .click();
  await card
    .getByRole("button", { name: "Confirm resolve comment", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await expect(page.locator("[data-pdf-comment-highlight]")).toHaveCount(0);
});

for (const previewOnly of [false, true]) {
  test(`canceling a Markdown preview draft removes both pane markers (preview only: ${previewOnly})`, async ({
    page,
  }) => {
    await page.goto("/?debug=markdown-preview");
    if (previewOnly)
      await page
        .getByRole("button", { name: "Toggle editor", exact: true })
        .click();
    const preview = page.frameLocator('iframe[title="README.md preview"]');
    const text = preview.locator("strong [data-comment-start]");
    await expect(text).toHaveText("GitHub-flavored Markdown");
    await text.evaluate((element) => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element.firstChild!);
      const selection = element.ownerDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    const input = previewOnly
      ? page
          .getByRole("dialog", { name: "PDF comment", exact: true })
          .getByPlaceholder("Write a comment...")
      : page.getByRole("textbox", { name: "Comment text", exact: true });
    await expect(input).toBeFocused();
    await input.fill("Canceled draft");
    await input.fill("");
    await page
      .getByRole("button", { name: "Cancel comment", exact: true })
      .click();
    await expect(page.locator("[data-pdf-comment-highlight]")).toHaveCount(0);
    await expect(page.locator(".cm-inlineCommentCard")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Object.values(
              JSON.parse(
                localStorage.getItem(
                  "catalex-harness-comments:/tmp/markdown-preview-harness",
                ) ?? "{}",
              ),
            ).flat().length,
        ),
      )
      .toBe(0);
  });
}
