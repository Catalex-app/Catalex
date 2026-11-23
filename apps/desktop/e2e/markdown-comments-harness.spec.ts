import { expect, test } from "@playwright/test";

test("a Markdown preview highlight can be resized and become a source comment", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview");
  const preview = page.frameLocator('iframe[title="README.md preview"]');
  const text = preview.locator("strong [data-comment-start]");
  await expect(text).toHaveText("GitHub-flavored Markdown");
  await text.evaluate((element) => {
    const doc = element.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(element);
    doc.getSelection()!.removeAllRanges();
    doc.getSelection()!.addRange(range);
  });
  const toolbar = page.locator("[data-selection-toolbar]");
  await toolbar.hover();
  const graphite = toolbar.getByRole("button", {
    name: "Set color to Graphite",
  });
  await graphite.press("Space");
  await expect(graphite).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: /^Show highlight H-/ }),
  ).toHaveCount(0);
  await page.keyboard.press("Tab");
  const action = toolbar.getByRole("button", {
    name: "Highlight",
    exact: true,
  });
  await expect(action).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: /^Show highlight H-/ }).first(),
  ).toBeVisible();
  await text.click();
  await toolbar.hover();
  await expect(
    toolbar.getByRole("button", { name: "Set color to Graphite" }),
  ).toHaveAttribute("aria-pressed", "true");
  const end = page.locator(
    '[data-testid="pdf-comment-layer"] [data-comment-range-handle="to"]',
  );
  await expect(end).toBeVisible();
  await expect(end).toHaveCSS("color", "rgb(140, 144, 148)");
  const box = (await end.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 30, y, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem(
              "catalex-harness-comments:/tmp/markdown-preview-harness",
            ) ?? "{}",
          )["README.md"]?.[0]?.to,
      ),
    )
    .toBeLessThan(51);
  const readHighlight = () =>
    page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem(
            "catalex-harness-comments:/tmp/markdown-preview-harness",
          ) ?? "{}",
        )["README.md"]?.[0],
    );
  const original = await readHighlight();
  const previewMark = page.locator(
    '[data-pdf-comment-highlight][aria-label^="Show highlight"]',
  );
  await text.click();
  await toolbar
    .getByRole("button", { name: "Remove highlight", exact: true })
    .click();
  await expect(previewMark).toBeVisible();
  expect(await readHighlight()).toMatchObject(original);
  await toolbar
    .getByRole("button", { name: "Confirm delete highlight", exact: true })
    .click();
  await expect(previewMark).toHaveCount(0);
  await expect.poll(readHighlight).toBeUndefined();
  await text.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(previewMark).toBeVisible();
  await expect.poll(readHighlight).toMatchObject(original);
  await text.click();
  await toolbar
    .getByRole("button", { name: "Add comment", exact: true })
    .click();
  const input = page.getByRole("textbox", { name: "Comment text" });
  await expect(input).toHaveCount(1);
  await input.fill("From a preview highlight");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(page.locator(".cm-inlineCommentCard")).toContainText(
    "From a preview highlight",
  );
  await expect(
    page.getByRole("button", {
      name: "Show human comment: From a preview highlight",
    }),
  ).toBeVisible();
});

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
  const toolbar = page.locator("[data-selection-toolbar]");
  await toolbar.hover();
  await toolbar.getByRole("button", { name: "Set color to Graphite" }).click();
  await expect(page.locator("[data-pdf-comment-highlight]")).toHaveCount(0);
  await toolbar.getByRole("button", { name: "Comment", exact: true }).click();
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
    color: "gray",
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
  await expect(page.locator("[data-pdf-comment-highlight]")).toHaveCSS(
    "--highlight-stroke",
    "#8c9094",
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
  await page.mouse.move(0, 0);
  await expect(card.locator(".cm-inlineCommentBadge")).toHaveCSS(
    "background-color",
    "rgb(63, 67, 71)",
  );
  await expect(card.locator(".cm-inlineCommentContent")).toHaveCSS(
    "background-color",
    "color(srgb 0.287647 0.303333 0.31902)",
  );
  for (const name of ["Copy comment text", "Delete comment", "Save comment"]) {
    await expect(card.getByRole("button", { name, exact: true })).toHaveCSS(
      "background-color",
      "color(srgb 0.269608 0.285294 0.30098)",
    );
  }
  await card
    .getByPlaceholder("Write a comment...")
    .fill("Updated preview comment");
  const save = card.getByRole("button", { name: "Save comment", exact: true });
  await save.hover();
  await expect(save).toHaveCSS(
    "background-color",
    "color(srgb 0.305686 0.321373 0.337059)",
  );
  await save.click();
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
