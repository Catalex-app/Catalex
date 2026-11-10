import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 1000 } });

test("the comment card and its actions fit beside the minimap at minimum pane width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 950 });
  await page.goto("/?debug=comment-workspace");
  const card = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="A-7"]',
  );
  const timestamp = card.locator(".cm-inlineCommentTimestamp");
  const agentName = card.locator(".cm-inlineCommentOrigin");
  const badge = card.locator(".cm-inlineCommentBadge");
  const tooltip = page.getByRole("tooltip");
  const pane = page.locator("[data-panel]").filter({ has: card });
  const minimap = pane.getByRole("complementary", { name: "Document minimap" });
  await expect(pane).toHaveCSS("width", "280px");
  await expect(minimap).toBeVisible();
  await expect(card).toBeVisible();
  const cardBox = (await card.boundingBox())!;
  const minimapBox = (await minimap.boundingBox())!;
  expect(cardBox.x + cardBox.width).toBeLessThan(minimapBox.x);
  await expect(timestamp).toBeHidden();
  await expect(agentName).toBeHidden();
  await badge.hover();
  await expect(tooltip).toHaveText("Just now · Demo agent");
  await page.mouse.move(10, 10);

  await page.setViewportSize({ width: 950, height: 950 });
  await expect(timestamp).toBeHidden();
  await expect(agentName).toBeVisible();
  await expect(async () => {
    await badge.hover();
    await expect(tooltip).toHaveText("Just now", { timeout: 1200 });
  }).toPass({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.mouse.move(10, 10);
  await expect(tooltip).toBeHidden();

  await page.setViewportSize({ width: 1280, height: 950 });
  await expect(timestamp).toBeVisible();
  await expect(agentName).toBeVisible();
  await badge.hover();
  await expect(badge.locator('[data-slot="tooltip-trigger"]')).toHaveAttribute(
    "data-state",
    "delayed-open",
  );
  await expect(tooltip).toBeHidden();

  await page.setViewportSize({ width: 800, height: 950 });
  await expect(pane).toHaveCSS("width", "280px");
  await badge.click();
  await expect(
    card.getByRole("button", { name: "Add comment A-7 to chat" }),
  ).toHaveAttribute("aria-pressed", "true");

  await card.getByRole("button", { name: "Edit comment", exact: true }).click();
  await expect(
    card.getByRole("textbox", { name: "Comment text" }),
  ).toBeVisible();

  const humanBadge = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="H-1"] .cm-inlineCommentBadge',
  );
  await humanBadge.hover();
  await expect(tooltip).toHaveText("Just now");
});

test("header copy appears on hover or keyboard focus and copies saved, lost and draft text", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?debug=comment-workspace&saving=edit&unplaced=1");
  const agent = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="A-7"]',
  );
  const copy = agent.locator(".cm-inlineCommentCopyButton");
  await expect(agent).toBeVisible();
  await page.mouse.move(10, 10);
  await expect(copy).toHaveCSS("opacity", "0");
  const height = await agent.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await agent.hover();
  await expect(copy).toHaveCSS("opacity", "1");
  await copy.hover();
  await expect(copy).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(
    await agent.evaluate((element) => element.getBoundingClientRect().height),
  ).toBe(height);
  await copy.click();
  await expect(copy).toHaveAttribute("aria-label", "Copied comment text");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Explain the evaluation challenge.",
  );
  await expect(agent).not.toHaveClass(/cm-inlineCommentSelected/);
  await expect(page.locator('[data-context-kind="comment"]')).toHaveCount(0);
  const copyBox = (await copy.boundingBox())!;
  const trash = agent.getByRole("button", {
    name: "Delete comment",
    exact: true,
  });
  const trashBox = (await trash.boundingBox())!;
  expect(copyBox.x + copyBox.width).toBeLessThanOrEqual(trashBox.x);
  expect(Math.abs(copyBox.y - trashBox.y)).toBeLessThan(1);
  await trash.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(copy).toBeFocused();
  await expect(copy).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.keyboard.press("Enter");
  await expect(copy).toHaveAttribute("aria-label", "Copied comment text");
  const human = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="H-3"]',
  );
  await human.hover();
  await human.locator(".cm-inlineCommentCopyButton").hover();
  await expect(human.locator(".cm-inlineCommentCopyButton")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await human.locator(".cm-inlineCommentCopyButton").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Please state the number of random seeds.",
  );
  const editing = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="H-1"]',
  );
  const editor = editing.getByRole("textbox", { name: "Comment text" });
  await editor.fill("Unsaved comment draft\nwith a second line");
  await editing.locator(".cm-inlineCommentCopyButton").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Unsaved comment draft\nwith a second line",
  );
  await expect(editor).toHaveValue("Unsaved comment draft\nwith a second line");
  await expect(editing).toHaveClass(/cm-inlineCommentCardEditing/);
  await expect(
    editing.getByRole("button", { name: "Save comment", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: "test-results/comment-copy-edit-and-lost.png",
  });
});

test("header copy remains available while saving and recovers from a clipboard failure", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?debug=comment-workspace&saving=card");
  const card = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="H-1"]',
  );
  const copy = card.locator(".cm-inlineCommentCopyButton");
  await expect(card).toHaveAttribute("aria-busy", "true");
  await card.hover();
  await expect(copy).toBeEnabled();
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    await card.locator(".cm-inlineCommentText").textContent(),
  );
  await expect(card).toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    let failed = false;
    navigator.clipboard.writeText = (text) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error("Test clipboard failure"));
      }
      return write(text);
    };
  });
  await copy.click();
  await expect(copy).toHaveAttribute("aria-label", "Copy failed — try again");
  await expect(
    page.getByText("Could not copy comment. Try again.", { exact: true }),
  ).toBeVisible();
  await copy.click();
  await expect(copy).toHaveAttribute("aria-label", "Copied comment text");
  await expect(card).toHaveAttribute("aria-busy", "true");
  await copy.focus();
  await page
    .getByRole("button", { name: "Finish comment save", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(card).toHaveAttribute("aria-busy", "false");
  await expect(copy).toBeFocused();
  await expect(card.locator(".cm-inlineCommentCopyButton")).toHaveCount(1);
});
