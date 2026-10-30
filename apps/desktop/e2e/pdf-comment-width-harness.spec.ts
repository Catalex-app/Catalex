import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1600, height: 1000 } });

async function openComment(page: Page) {
  const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
  await expect(async () => {
    const line = page
      .locator(".mupdf-text-layer text")
      .filter({ hasText: "Your abstract here." })
      .first();
    await line.evaluate((element) =>
      element.scrollIntoView({ block: "center" }),
    );
    const box = await line.boundingBox();
    await page.mouse.click(box!.x + 4, box!.y + box!.height / 2);
    await expect(card).toBeVisible({ timeout: 500 });
  }).toPass();
  return card;
}

test("PDF-only width preference persists and preserves unfinished edits", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&mode=duet");
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  await page.getByRole("button", { name: "Fit width", exact: true }).click();
  const card = await openComment(page);
  const full = card.getByRole("button", {
    name: "Full comment width",
    exact: true,
  });
  await expect(full).toHaveAttribute("aria-pressed", "false");
  await expect(full.locator("..")).toHaveClass("cm-inlineCommentMeta");
  await expect(full).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect.poll(async () => (await card.boundingBox())!.width).toBe(860);
  await full.click();
  await expect(full).toHaveAttribute("aria-pressed", "true");
  await expect(full).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect
    .poll(async () => (await card.boundingBox())!.width)
    .toBeGreaterThan(860);
  await card.getByRole("button", { name: "Edit comment", exact: true }).click();
  const input = card.getByRole("textbox", {
    name: "Comment text",
    exact: true,
  });
  await input.fill("Unfinished edit survives changing width");
  await full.click();
  await expect(input).toHaveValue("Unfinished edit survives changing width");
  await expect.poll(async () => (await card.boundingBox())!.width).toBe(860);
  await full.click();
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(card).toContainText("Unfinished edit survives changing width");
  await page.screenshot({ path: test.info().outputPath("full-width.png") });
  await page.reload();
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  await openComment(page);
  await expect(full).toHaveAttribute("aria-pressed", "true");
  await expect(full).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await full.click();
  await expect(full).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.screenshot({ path: test.info().outputPath("capped-width.png") });
  await card.getByRole("button", { name: "Edit comment", exact: true }).click();
  await input.fill("Draft survives hiding the width toggle");
  await page.setViewportSize({ width: 700, height: 1000 });
  await expect(full).toHaveCount(0);
  await expect(input).toHaveValue("Draft survives hiding the width toggle");
  await expect
    .poll(async () => (await card.boundingBox())!.width)
    .toBeLessThan(700);
  await page.screenshot({ path: test.info().outputPath("narrow-width.png") });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(full).toHaveAttribute("aria-pressed", "false");
  await expect(input).toHaveValue("Draft survives hiding the width toggle");
  await full.click();
  await page.setViewportSize({ width: 700, height: 1000 });
  await expect(full).toHaveCount(0);
  await expect
    .poll(async () => (await card.boundingBox())!.width)
    .toBeLessThan(700);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(full).toHaveAttribute("aria-pressed", "true");
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  // A narrow PDF page also makes the toggle redundant in a wide window.
  await page.getByRole("button", { name: "Fit height", exact: true }).click();
  await openComment(page);
  await expect(full).toHaveCount(0);
  await page.getByRole("button", { name: "Fit width", exact: true }).click();
  await openComment(page);
  await expect(full).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Full comment width", exact: true }),
  ).toHaveCount(0);
});
