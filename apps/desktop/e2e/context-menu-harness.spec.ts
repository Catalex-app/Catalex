import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("editor menu preserves selection and uses undoable model edits", async ({
  page,
}) => {
  await page.goto("/?debug=context-menu");
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await editor.click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Copy", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    animations: "disabled",
    path: "test-results/context-menu-editor-light.png",
  });
  await page.getByRole("menuitem", { name: "Cut", exact: true }).click();
  await expect(editor).toHaveText(" beta gamma");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "alpha",
  );
  await editor.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Undo", exact: true }).click();
  await expect(editor).toHaveText("alpha beta gamma");
  await editor.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Redo", exact: true }).click();
  await expect(editor).toHaveText(" beta gamma");
  await editor.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Select All", exact: true }).click();
  await page.evaluate(() =>
    navigator.clipboard.writeText("replacement\nsecond line"),
  );
  await editor.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Paste", exact: true }).click();
  await expect(editor).toContainText("replacement");
  await editor.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Undo", exact: true }).click();
  await expect(editor).toHaveText(" beta gamma");
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await editor.click({ button: "right" });
  await page.screenshot({
    animations: "disabled",
    path: "test-results/context-menu-editor-dark.png",
  });
  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
});

test("input menus preserve native undo, protect passwords, and respect readonly", async ({
  page,
}) => {
  await page.goto("/?debug=context-menu");
  const input = page.getByRole("textbox", { name: "Text input", exact: true });
  await input.selectText();
  await input.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Cut", exact: true }).click();
  await expect(input).toHaveValue("");
  await input.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Undo", exact: true }).click();
  await expect(input).toHaveValue("input selection");
  await input.selectText();
  await page.evaluate(() => navigator.clipboard.writeText("new input"));
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Paste", exact: true }).click();
  await expect(input).toHaveValue("new input");
  await page
    .getByRole("textbox", { name: "Read only", exact: true })
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Paste", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByLabel("Password", { exact: true }).selectText();
  await page.getByLabel("Password", { exact: true }).click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Copy", exact: true }),
  ).toBeDisabled();
});

test("links reuse navigation and existing menus win over the shell fallback", async ({
  page,
}) => {
  await page.goto("/?debug=context-menu");
  const link = page.getByRole("link", { name: "Reference link" });
  await link.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy Link", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "https://example.com/reference",
  );
  await link.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open Link", exact: true }).click();
  await expect(page.getByLabel("Opened links")).toHaveText("1");
  await page.getByText("Existing file menu").click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText([
    "Rename",
    "Move to Trash",
  ]);
  await page.keyboard.press("Escape");
  await page.getByTestId("empty").click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Toggle theme" })
    .click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("Markdown iframe menus copy and add source-backed comments", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview");
  const preview = page.frameLocator('iframe[title="README.md preview"]');
  const text = preview.locator("strong [data-comment-start]");
  await expect(text).toHaveText("GitHub-flavored Markdown");
  const select = async () =>
    text.evaluate((element) => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element.firstChild!);
      const selection = element.ownerDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  await select();
  await text.click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText(["Copy", "Add Comment"]);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/context-menu-markdown.png",
  });
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "GitHub-flavored Markdown",
  );
  await select();
  await text.click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Add Comment", exact: true })
    .click();
  // With the source editor visible, preview comments open in its inline card.
  const card = page.locator(".cm-inlineCommentCard");
  await card
    .getByPlaceholder("Write a comment...")
    .fill("Context menu comment");
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(page.locator(".cm-editor")).toContainText(
    "Context menu comment",
  );
  await preview
    .getByRole("link", { name: "a local link" })
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Open Link", exact: true }),
  ).toBeVisible();
  await preview
    .getByRole("heading", { name: "Markdown Preview", exact: true })
    .click();
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("PDF selection menu copies and creates a comment using the resolved source", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&formatted");
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Your abstract here." })
    .first();
  await expect(line).toBeVisible();
  const select = async () => {
    await line.evaluate((element) => {
      const node = element.firstChild!;
      const text = node.textContent!;
      window
        .getSelection()!
        .setBaseAndExtent(
          node,
          text.indexOf("Your"),
          node,
          text.indexOf("abstract") + "abstract".length,
        );
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await expect(
      page.getByRole("button", { name: "Comment", exact: true }),
    ).toBeEnabled();
  };
  await select();
  const bounds = await line.boundingBox();
  await page.mouse.click(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
    { button: "right" },
  );
  await expect(page.getByRole("menuitem")).toHaveText(["Copy", "Add Comment"]);
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Your abstract",
  );
  await select();
  await page.mouse.click(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
    { button: "right" },
  );
  await expect(
    page.getByRole("menuitem", { name: "Add Comment", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    animations: "disabled",
    path: "test-results/context-menu-pdf.png",
  });
  await page
    .getByRole("menuitem", { name: "Add Comment", exact: true })
    .click();
  const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
  await card
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("PDF context comment");
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(
          localStorage.getItem(
            "catalex-harness-comments:/tmp/catalex-pdf-comments-harness",
          ) ?? "{}",
        )["chapter.tex"]?.some(
          (comment: { text: string }) => comment.text === "PDF context comment",
        ),
      ),
    )
    .toBe(true);
});

test("text context menu works inside a modal without dismissing it", async ({
  page,
}) => {
  await page.goto("/?debug=context-menu");
  await page.getByRole("button", { name: "Open dialog", exact: true }).click();
  const input = page.getByRole("textbox", {
    name: "Dialog input",
    exact: true,
  });
  await input.selectText();
  await input.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Cut", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("dialog")).toBeVisible();
  await input.click({ button: "right" });
  await page.keyboard.press("Escape");
  await expect(input).toBeFocused();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("menus leave a pointer gap and fade without changing geometry", async ({
  page,
}) => {
  await page.goto("/?debug=context-menu");
  const input = page.getByRole("textbox", { name: "Text input", exact: true });
  await input.click();
  const box = await input.boundingBox();
  if (!box) throw new Error("Missing input");
  await page.evaluate(() => {
    document.addEventListener("animationstart", (event) => {
      const element = event.target;
      if (
        !(element instanceof HTMLElement) ||
        !element.matches('[data-slot="context-menu-content"]')
      )
        return;
      for (const animation of element.getAnimations()) {
        animation.pause();
        animation.currentTime = 100;
      }
    });
  });
  const point = { x: Math.floor(box.x + 30), y: Math.floor(box.y + 10) };
  await page.mouse.click(point.x, point.y, { button: "right" });
  const menu = page.locator('[data-slot="context-menu-content"]');
  await expect(menu).toBeVisible();
  const rect = await menu.boundingBox();
  expect(rect?.x).toBeCloseTo(point.x + 8, 0);
  expect(rect?.y).toBeCloseTo(point.y + 8, 0);
  const sampleFade = async () =>
    menu.evaluate((element) => {
      const animation = element.getAnimations()[0];
      if (!animation) throw new Error("Missing fade");
      animation.pause();
      animation.currentTime = 100;
      const style = getComputedStyle(element);
      return {
        opacity: Number(style.opacity),
        transform: style.transform,
        frames: (animation.effect as KeyframeEffect).getKeyframes(),
      };
    });
  const entrance = await sampleFade();
  expect(entrance.opacity).toBeGreaterThan(0);
  expect(entrance.opacity).toBeLessThan(1);
  expect(entrance.transform).toBe("none");
  expect(entrance.frames.every((frame) => !("transform" in frame))).toBe(true);
  await page.screenshot({
    path: "test-results/context-menu-gap.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  const exit = await sampleFade();
  expect(exit.opacity).toBeGreaterThan(0);
  expect(exit.opacity).toBeLessThan(1);
  expect(exit.transform).toBe("none");
  expect(exit.frames.every((frame) => !("transform" in frame))).toBe(true);
  await page.screenshot({ path: "test-results/context-menu-fade.png" });
  await menu.evaluate((element) =>
    element.getAnimations().forEach((animation) => animation.finish()),
  );
  await expect(menu).toHaveCount(0);
});

test("editor selection popup uses the same stationary fade", async ({
  page,
}) => {
  await page.goto("/?debug=context-menu");
  await page.evaluate(() => {
    const animate = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (
        this.matches("[data-selection-toolbar], [data-selection-toolbar-exit]")
      ) {
        animation.pause();
        animation.currentTime = 100;
      }
      return animation;
    };
  });
  await page.getByRole("button", { name: "Show selection popup" }).click();
  const toolbar = page.locator(
    "[data-selection-toolbar], [data-selection-toolbar-exit]",
  );
  await expect(toolbar).toBeVisible();
  const before = await toolbar.boundingBox();
  const checkFade = async () => {
    const state = await toolbar.evaluate((element) => {
      const animation = element.getAnimations()[0];
      return {
        opacity: Number(getComputedStyle(element).opacity),
        frames: (animation.effect as KeyframeEffect).getKeyframes(),
        duration: animation.effect?.getTiming().duration,
      };
    });
    expect(state.opacity).toBeGreaterThan(0);
    expect(state.opacity).toBeLessThan(1);
    expect(state.duration).toBe(200);
    expect(state.frames.every((frame) => !("transform" in frame))).toBe(true);
  };
  await checkFade();
  await page.keyboard.press("Escape");
  await checkFade();
  expect(await toolbar.boundingBox()).toEqual(before);
  await page.screenshot({ path: "test-results/selection-popup-fade.png" });
});
