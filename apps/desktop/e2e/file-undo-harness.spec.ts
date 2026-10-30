import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 1000 } });
test("file undo includes grouped unsaved comment typing, save, and source edits", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?debug=comment-workspace");
  const content = page.locator(".cm-content").first();
  const card = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="A-7"]',
  );
  await expect(card).toBeVisible();
  await content.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.insertText("SOURCE ");
  await expect(content).toContainText("SOURCE ");
  await card.getByRole("button", { name: "Edit comment", exact: true }).click();
  const input = card.getByRole("textbox", { name: "Comment text" });
  await expect(input).toHaveValue("Explain the evaluation challenge.");
  await input.focus();
  await input.evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(el.value.length, el.value.length),
  );
  await input.pressSequentially(" Added words", { delay: 25 });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input).toHaveValue("Explain the evaluation challenge.");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(content).not.toContainText("SOURCE ");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(content).toContainText("SOURCE ");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveValue(
    "Explain the evaluation challenge. Added words",
  );
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(card.locator(".cm-inlineCommentText")).toContainText(
    "Added words",
  );
  await card.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input).toHaveValue(
    "Explain the evaluation challenge. Added words",
  );
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input).toHaveValue("Explain the evaluation challenge.");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveValue(
    "Explain the evaluation challenge. Added words",
  );
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(card.locator(".cm-inlineCommentText")).toContainText(
    "Added words",
  );
  await page.screenshot({ path: "test-results/file-undo.png" });
  expect(errors).toEqual([]);
});

test("preview shortcuts use the file history and new typing clears redo", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace");
  const card = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="A-7"]',
  );
  await card.getByRole("button", { name: "Edit comment", exact: true }).click();
  const input = card.getByRole("textbox", { name: "Comment text" });
  await input.fill("First draft");
  const preview = page.frameLocator('iframe[title="manuscript.md preview"]');
  await preview
    .getByRole("heading", { name: "Learning with limited data" })
    .click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input).toHaveValue("Explain the evaluation challenge.");
  await input.fill("Replacement draft");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(input).toHaveValue("Replacement draft");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input).toHaveValue("Explain the evaluation challenge.");
});

test("unsaved comment history stays with its file across tab switches", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace");
  const card = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="A-7"]',
  );
  await card.getByRole("button", { name: "Edit comment", exact: true }).click();
  await card
    .getByRole("textbox", { name: "Comment text" })
    .fill("Manuscript draft");
  await page.getByText("review-notes.md", { exact: true }).first().dblclick();
  const content = page.locator(".cm-content").first();
  await expect(content).toContainText("# Review notes");
  await content.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.insertText("NOTES ");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(content).not.toContainText("NOTES ");
  await page.getByText("manuscript.md", { exact: true }).first().dblclick();
  const input = card.getByRole("textbox", { name: "Comment text" });
  await expect(input).toHaveValue("Manuscript draft");
  await input.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input).toHaveValue("Explain the evaluation challenge.");
});

test("clicking a saved card transfers undo focus away from chat", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace");
  const content = page.locator(".cm-content").first();
  await content.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.insertText("UNDO CARD ");
  await expect(content).toContainText("UNDO CARD ");
  const chat = page
    .locator("textarea[data-chat-composer-input]:visible")
    .last();
  await chat.fill("Keep this chat draft");
  const card = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="A-7"]',
  );
  await card.click();
  await expect(card).toBeFocused();
  await expect(card).toHaveCSS("outline-style", "none");
  await page.screenshot({ path: "test-results/comment-card-focus.png" });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(content).not.toContainText("UNDO CARD ");
  await expect(chat).toHaveValue("Keep this chat draft");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(content).toContainText("UNDO CARD ");
});
