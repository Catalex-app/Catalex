import { expect, test } from "@playwright/test";

test("highlights keep their number and color when adding or clearing comment text", async ({
  page,
}, info) => {
  await page.goto("/?debug=editor-comments");
  await page.waitForFunction(() => window.__editorCommentsHarness?.ready);
  await page.evaluate(() =>
    window.__editorCommentsHarness!.selectText!("line 20"),
  );

  const toolbar = page.locator("[data-selection-toolbar]");
  const expectPaletteSpacing = async () => {
    await expect(toolbar).toHaveCSS("width", "184px");
    const palette = toolbar.getByRole("group", { name: "Color" });
    const swatches = palette.getByRole("button");
    await expect(swatches).toHaveCount(6);
    const menu = (await toolbar.boundingBox())!;
    const first = (await swatches.first().boundingBox())!;
    const last = (await swatches.last().boundingBox())!;
    expect(first.width).toBeCloseTo(28.17, 1);
    expect(first.height).toBe(32);
    expect(last.width).toBeCloseTo(first.width, 1);
    expect(first.x - menu.x).toBe(5);
    expect(menu.x + menu.width - last.x - last.width).toBeCloseTo(5, 0);
    const positions = await swatches.evaluateAll((buttons) =>
      buttons.map((button) => button.getBoundingClientRect().left),
    );
    for (let index = 1; index < positions.length; index++)
      expect(positions[index] - positions[index - 1]).toBeCloseTo(29.17, 1);
  };
  await expect(
    toolbar.getByRole("button", { name: "Highlight", exact: true }),
  ).toHaveCount(1);
  await expect(
    toolbar.getByRole("button", { name: "Set color to Yellow" }),
  ).toHaveAttribute("aria-pressed", "true");
  await toolbar.hover();
  await expectPaletteSpacing();
  await expect(
    toolbar.getByRole("button", { name: /^Set color to / }),
  ).toHaveCount(6);
  await toolbar.screenshot({
    path: info.outputPath("selection-palette.png"),
    animations: "disabled",
  });
  await toolbar.getByRole("button", { name: "Set color to Blue" }).click();
  await expect(page.locator(".cm-inlineCommentMark")).toHaveCount(0);
  await expect(
    toolbar.getByRole("button", { name: "Set color to Blue" }),
  ).toHaveAttribute("aria-pressed", "true");
  await toolbar.getByRole("button", { name: "Highlight", exact: true }).click();

  const mark = page
    .locator(".cm-inlineCommentMark")
    .filter({ hasText: "line 20" });
  const highlight = page.getByRole("button", { name: /^Show highlight H-/ });
  await expect(mark).toBeVisible();
  await expect(highlight).toBeVisible();
  const label = await highlight.textContent();
  await expect(page.locator(".cm-inlineCommentCard")).toHaveCount(0);
  await mark.click();
  await toolbar.hover();
  await expect(
    toolbar.getByRole("button", { name: "Set color to Blue" }),
  ).toHaveAttribute("aria-pressed", "true");
  await toolbar.hover();
  await toolbar.getByRole("button", { name: "Set color to Green" }).click();
  await expect(
    toolbar.getByRole("button", { name: "Set color to Green" }),
  ).toHaveAttribute("aria-pressed", "true");
  await toolbar
    .getByRole("button", { name: "Add comment", exact: true })
    .click();

  const input = page.getByRole("textbox", { name: "Comment text" });
  const save = page.getByRole("button", { name: "Save comment", exact: true });
  await input.fill("Keep this passage");
  await save.click();
  const card = page.locator(".cm-inlineCommentCard");
  await expect(card).toContainText("Keep this passage");
  await expect(card.locator(".cm-inlineCommentBadge")).toHaveText(label!);
  await mark.click();
  await toolbar.hover();
  await expectPaletteSpacing();
  const pinkChoice = toolbar.getByRole("button", { name: "Set color to Pink" });
  const pinkDot = pinkChoice.locator("span");
  await expect(pinkDot).toHaveCSS("box-shadow", "none");
  await pinkChoice.hover();
  await expect(pinkChoice).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(pinkDot).not.toHaveCSS("box-shadow", "none");
  const selectedDot = toolbar
    .getByRole("button", { name: "Set color to Green" })
    .locator("span");
  const selectedOutline = await selectedDot.evaluate(
    (dot) => getComputedStyle(dot).boxShadow,
  );
  await expect(pinkDot).not.toHaveCSS("box-shadow", selectedOutline);
  await expect(
    toolbar.getByRole("button", { name: /^Set color to / }),
  ).toHaveCount(6);
  await expect(
    toolbar.getByRole("button", { name: "Remove highlight", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Delete comment", exact: true }),
  ).toBeAttached();
  await card.getByRole("button", { name: "Edit comment", exact: true }).click();
  await input.fill("  ");
  await save.click();
  await expect(highlight).toHaveText(label!);
  await expect(card).toHaveCount(0);

  await page.reload();
  await expect(highlight).toHaveText(label!);
  await highlight.click();
  await toolbar.hover();
  await expectPaletteSpacing();
  await expect(
    toolbar.getByRole("button", { name: "Set color to Green" }),
  ).toHaveAttribute("aria-pressed", "true");
  const readHighlight = () =>
    page.evaluate(
      () =>
        JSON.parse(
          localStorage.getItem(
            "catalex-harness-comments:/tmp/comment-harness",
          ) ?? "{}",
        )["main.tex"]?.[0],
    );
  const original = await readHighlight();
  expect(original).toMatchObject({ color: "green", text: "" });
  const remove = toolbar.getByRole("button", {
    name: "Remove highlight",
    exact: true,
  });
  const confirm = toolbar.getByRole("button", {
    name: "Confirm delete highlight",
    exact: true,
  });
  await remove.click();
  await expect(confirm.getByText("Delete?", { exact: true })).toBeVisible();
  await expect(highlight).toBeVisible();
  expect(await readHighlight()).toMatchObject(original);
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await highlight.click();
  await remove.click();
  await confirm.press("Enter");
  await expect(highlight).toHaveCount(0);
  await expect.poll(readHighlight).toBeUndefined();
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(highlight).toHaveText(label!);
  await expect(mark).toHaveText("line 20");
  await expect.poll(readHighlight).toMatchObject(original);

  await page.mouse.move(0, 0);
  await page.evaluate(() =>
    window.__editorCommentsHarness!.selectText!("line 21"),
  );
  const currentColor = toolbar.getByRole("button", {
    name: "Set color to Green",
  });
  await expect(currentColor).toBeVisible();
  await expect(currentColor).toHaveAttribute("aria-pressed", "true");
  const createHighlight = toolbar.getByRole("button", {
    name: "Highlight",
    exact: true,
  });
  await expect(createHighlight.locator("svg")).toHaveCSS("width", "16px");
  await expect(
    toolbar.getByRole("button", { name: /^Set color to / }),
  ).toHaveCount(1);
  await currentColor.focus();
  const colors = toolbar.getByRole("button", { name: /^Set color to / });
  await expect(colors).toHaveCount(6);
  await expect(toolbar).toHaveCSS("width", "184px");
  const swatch = toolbar
    .getByRole("button", { name: "Set color to Green" })
    .locator("span");
  await expect(swatch).toHaveCSS("width", "12px");
  await expect(swatch).toHaveCSS("--tw-ring-offset-width", "1px");
  await expect
    .poll(() =>
      colors.evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      ),
    )
    .toEqual(
      ["Yellow", "Orange", "Green", "Blue", "Pink", "Graphite"].map(
        (color) => `Set color to ${color}`,
      ),
    );
  await page.keyboard.press("Shift+Tab");
  const orange = toolbar.getByRole("button", { name: "Set color to Orange" });
  await expect(orange).toBeFocused();
  await page.keyboard.press("Space");
  await expect(orange).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cm-inlineCommentMark")).toHaveCount(1);
  for (let index = 0; index < 5; index++) await page.keyboard.press("Tab");
  await expect(createHighlight).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".cm-inlineCommentMark").filter({ hasText: "line 21" }),
  ).toBeVisible();
});

test("comment creation waits for the initial native snapshot without losing the selection", async ({
  page,
}) => {
  await page.route("**/desktop-browser-mocks.ts*", async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = 'if (cmd === "read_project_comments_anchored") {';
    expect(body).toContain(marker);
    await route.fulfill({
      response,
      body: body.replace(
        marker,
        `${marker}
      if (!globalThis.__commentLoadReleased) await new Promise(resolve => {
        (globalThis.__commentLoadWaiters ??= []).push(resolve);
      });
    `,
      ),
    });
  });
  await page.goto("/?debug=editor-comments");
  await page.waitForFunction(() => window.__editorCommentsHarness?.ready);
  await page.evaluate(() =>
    window.__editorCommentsHarness!.selectText!("line 20"),
  );
  const comment = page.getByRole("button", { name: "Comment", exact: true });
  await expect(comment).toBeVisible();
  await expect(comment).toBeDisabled();
  await page.waitForFunction(
    () => (globalThis as any).__commentLoadWaiters?.length > 0,
  );
  await page.evaluate(() => {
    (globalThis as any).__commentLoadReleased = true;
    for (const resolve of (globalThis as any).__commentLoadWaiters) resolve();
  });
  await expect(comment).toBeEnabled();
  await comment.click();
  const input = page.getByRole("textbox", {
    name: "Comment text",
    exact: true,
  });
  await input.fill("Saved after the initial load");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(page.locator(".cm-inlineCommentCard")).toContainText(
    "Saved after the initial load",
  );
  await expect(page.locator(".cm-inlineCommentMark")).toHaveText("line 20");
});

test("clean disk refresh waits for native anchor recovery while dirty store edits map locally", async ({
  page,
}) => {
  const key = "catalex-harness-comments:/tmp/comment-harness";
  await page.addInitScript(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          "main.tex": [
            {
              id: "external",
              from: 2,
              to: 17,
              line: 1,
              text: "Keep the native recovery decision",
            },
          ],
        }),
      ),
    key,
  );
  await page.goto("/?debug=editor-comments");
  await expect(page.locator(".cm-inlineCommentCard")).toContainText(
    "Keep the native recovery decision",
  );
  const read = () =>
    page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!)["main.tex"][0],
      key,
    );
  const before = await read();
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { flushProjectCommentWrites } = await import(
      "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
    );
    await flushProjectCommentWrites("/tmp/comment-harness");
    useDocumentStore.setState((state) => ({
      files: state.files.map((file) =>
        file.relativePath === "main.tex"
          ? {
              ...file,
              content: `External prefix\n${file.content}`,
              diskContent: `External prefix\n${file.content}`,
              isDirty: false,
            }
          : file,
      ),
    }));
  });
  await expect(page.locator(".cm-line").first()).toContainText(
    "External prefix",
  );
  await page.evaluate(async () => {
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const { flushProjectCommentWrites } = await import(
      "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
    );
    await flushProjectCommentWrites("/tmp/comment-harness");
  });
  expect(await read()).toEqual(before);
  await page.evaluate(async () => {
    const { synchronizeProjectCommentAnchors } = await import(
      "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
    );
    await synchronizeProjectCommentAnchors("/tmp/comment-harness");
  });
  await expect
    .poll(async () => (await read()).from)
    .toBe(before.from + "External prefix\n".length);
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const store = useDocumentStore.getState();
    const file = store.files.find((file) => file.relativePath === "main.tex")!;
    store.updateFileContent(file.id, `Local prefix\n${file.content}`);
  });
  await expect
    .poll(async () => (await read()).from)
    .toBe(before.from + "External prefix\nLocal prefix\n".length);
});

for (const author of ["human", "agent"] as const) {
  test(`editor comments harness restores ${author} comments after image switches`, async ({
    page,
  }) => {
    const storageKey = "catalex-harness-comments:/tmp/comment-harness";
    await page.addInitScript(
      ({ storageKey, author }) => {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            "main.tex": [
              {
                id: "switch-comment",
                from: 2,
                to: 17,
                line: 1,
                text: "Keep this comment visible after switching files.",

                ...(author === "agent"
                  ? { origin: { provider: "codex", sessionId: "switch-test" } }
                  : {}),
              },
            ],
          }),
        );
      },
      { storageKey, author },
    );
    await page.goto("/?debug=editor-comments");
    const card = page.locator(".cm-inlineCommentCard");
    await expect(card).toContainText("Keep this comment visible");
    const storedBefore = await page.evaluate(
      (key) => localStorage.getItem(key),
      storageKey,
    );

    for (let round = 0; round < 3; round++) {
      await page
        .getByRole("button", { name: "figure.svg", exact: true })
        .click();
      await expect(page.locator(".cm-editor")).toHaveCount(0);
      await expect(page.getByRole("img", { name: "figure.svg" })).toBeVisible();
      await page.getByRole("button", { name: "main.tex", exact: true }).click();
      await expect(card).toContainText("Keep this comment visible");
      await expect(page.locator(".cm-inlineCommentMark")).toHaveCount(1);
      await expect(page.locator(".cm-inlineCommentAgent")).toHaveCount(
        author === "agent" ? 1 : 0,
      );
    }
    expect(
      await page.evaluate((key) => localStorage.getItem(key), storageKey),
    ).toBe(storedBefore);

    await page.getByRole("button", { name: "Edit comment" }).click();
    await page
      .getByRole("textbox", { name: "Comment text", exact: true })
      .fill("Updated after switching.");
    await page
      .getByRole("textbox", { name: "Comment text", exact: true })
      .press("Enter");
    await expect(card).toContainText("Updated after switching.");
    await page.getByRole("button", { name: "Resolve comment" }).click();
    await expect(
      page.getByRole("button", { name: "Confirm resolve comment" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm resolve comment" }).click();
    await expect(card).toHaveCount(0);
  });
}

test("editor comments harness centers the new comment card after comment action", async ({
  page,
}) => {
  await page.goto("/?debug=editor-comments", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-comments-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorCommentsHarness?.ready;
  });

  const selected = await page.evaluate(() => {
    return window.__editorCommentsHarness?.selectText?.("line 20");
  });
  expect(selected).toBe(true);

  await page.getByRole("button", { exact: true, name: "Comment" }).click();
  await expect(
    page.getByRole("textbox", { name: "Comment text", exact: true }),
  ).toBeVisible();

  const cardPosition = await page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller");
    const card = document.querySelector(".cm-inlineCommentCard");
    if (!(scroller instanceof HTMLElement) || !(card instanceof HTMLElement)) {
      return null;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      cardCenter: cardRect.top + cardRect.height / 2,
      viewportCenter: scrollerRect.top + scrollerRect.height / 2,
    };
  });

  expect(cardPosition).not.toBeNull();
  expect(
    Math.abs(cardPosition!.cardCenter - cardPosition!.viewportCenter),
  ).toBeLessThanOrEqual(4);
});

test("editor comments harness adds an inline comment from selected text", async ({
  page,
}) => {
  await page.goto("/?debug=editor-comments", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-comments-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorCommentsHarness?.ready;
  });

  const selected = await page.evaluate(() => {
    return window.__editorCommentsHarness?.selectText?.("line 3");
  });
  expect(selected).toBe(true);

  await expect(
    page.getByRole("button", { exact: true, name: "Comment" }),
  ).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Comment" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Clarify the third harness line.");
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .press("Enter");

  await expect(page.locator(".cm-inlineCommentCard")).toHaveText(
    /Clarify the third harness line\./,
  );
  await expect(page.locator(".cm-inlineCommentTime")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resolve comment" }),
  ).toHaveText("");
  await expect(page.locator('[data-inline-comment-input="reply"]')).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "Edit comment" }).click();
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Updated third-line note.");
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .press("Enter");

  await expect(page.locator(".cm-inlineCommentCard")).toHaveText(
    /Updated third-line note\./,
  );

  await page.getByRole("button", { name: "Edit comment" }).click();
  await page.getByRole("button", { name: "Delete comment" }).click();
  await page.getByRole("button", { name: "Confirm delete comment" }).click();
  await expect(page.locator(".cm-inlineCommentCard")).toHaveCount(0);

  const state = await page.evaluate(() => {
    return window.__editorCommentsHarness?.getState?.();
  });
  expect(state?.cards).toEqual([]);
  expect(state?.markCount).toBe(0);

  await page.evaluate(() => {
    return window.__editorCommentsHarness?.selectText?.("line 2");
  });
  // Programmatic selection can finish scrolling after the card is removed.
  // Bring its source into view before using the viewport-bound toolbar.
  await page
    .locator(".cm-line")
    .filter({ hasText: /^Harness line 2$/ })
    .scrollIntoViewIfNeeded();
  await page.getByRole("button", { exact: true, name: "Comment" }).click();
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Resolve this line.");
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .press("Enter");
  await page.getByRole("button", { name: "Resolve comment" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm resolve comment" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Confirm resolve comment" }).click();
  await expect(page.locator(".cm-inlineCommentCard")).toHaveCount(0);

  await page.screenshot({
    path: "test-results/editor-comments-harness.png",
    fullPage: true,
  });
});

test("editor comments harness smoothly transitions the same card between read and edit", async ({
  page,
}) => {
  await page.goto("/?debug=editor-comments", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-comments-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorCommentsHarness?.ready;
  });

  const selected = await page.evaluate(() => {
    return window.__editorCommentsHarness?.selectText?.("line 3");
  });
  expect(selected).toBe(true);

  await page.getByRole("button", { exact: true, name: "Comment" }).click();
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Check the transition between both comment states.");
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .press("Enter");

  const card = page.locator(".cm-inlineCommentCard");
  await card.evaluate((element) => {
    element.dataset.transitionIdentity = "preserved";
  });

  await page.getByRole("button", { name: "Edit comment" }).click();

  await expect(card).toHaveAttribute("data-transition-identity", "preserved");
  await expect(card).toHaveClass(/cm-inlineCommentCardEditing/);
  await expect(
    page.getByRole("textbox", { name: "Comment text", exact: true }),
  ).toBeFocused();

  const backgroundInsets = await card.evaluate((element) => {
    const content = element.querySelector(".cm-inlineCommentContent");
    if (!(content instanceof HTMLElement)) return null;
    const cardRect = element.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      left: contentRect.left - cardRect.left,
      right: cardRect.right - contentRect.right,
    };
  });
  expect(backgroundInsets).toEqual({ left: 0, right: 0 });

  const renderedMotion = await card.evaluate((element) => {
    const content = element.querySelector(".cm-inlineCommentContent");
    const header = element.querySelector(".cm-inlineCommentHeader");
    const body = content?.lastElementChild;
    if (!(content instanceof HTMLElement) || !(header instanceof HTMLElement)) {
      return null;
    }
    if (!(body instanceof HTMLElement)) return null;
    return {
      bodyTransitionDuration: getComputedStyle(body).transitionDuration,
      contentDisplay: getComputedStyle(content).display,
      headerTransitionDuration: getComputedStyle(header).transitionDuration,
    };
  });

  expect(renderedMotion).toEqual({
    bodyTransitionDuration: "0.16s",
    contentDisplay: "grid",
    headerTransitionDuration: "0.16s",
  });

  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .press("Enter");
  await expect(card).toHaveAttribute("data-transition-identity", "preserved");
  await expect(card).not.toHaveClass(/cm-inlineCommentCardEditing/);
  await expect(page.locator(".cm-inlineCommentText")).toHaveText(
    "Check the transition between both comment states.",
  );
});

test("editor comments harness rejects full-document comment ranges @core", async ({
  page,
}) => {
  await page.goto("/?debug=editor-comments", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-comments-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorCommentsHarness?.ready;
  });

  const selected = await page.evaluate(() => {
    const state = window.__editorCommentsHarness?.getState?.();
    if (!state?.docLength) return false;
    return window.__editorCommentsHarness?.selectRange?.(0, state.docLength);
  });
  expect(selected).toBe(true);

  await expect(
    page.getByRole("button", { exact: true, name: "Comment" }),
  ).toBeHidden();

  await expect(
    page.getByRole("textbox", { name: "Comment text", exact: true }),
  ).toHaveCount(0);

  const state = await page.evaluate(() => {
    return window.__editorCommentsHarness?.getState?.();
  });
  expect(state?.cards).toEqual([]);
  expect(state?.markCount).toBe(0);
});

test("editor comments harness does not expand comments across full-document replacements", async ({
  page,
}) => {
  await page.goto("/?debug=editor-comments", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-comments-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorCommentsHarness?.ready;
  });

  const selected = await page.evaluate(() => {
    return window.__editorCommentsHarness?.selectTextInRow?.(
      "Harness line 3",
      "line 3",
    );
  });
  expect(selected).toBe(true);

  await page.getByRole("button", { exact: true, name: "Comment" }).click();
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Review this polished line.");
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .press("Enter");
  await expect(page.locator(".cm-inlineCommentMark")).toHaveCount(1);

  const replaced = await page.evaluate(() => {
    const state = window.__editorCommentsHarness?.getState?.();
    const nextDoc = state?.docText?.replace(
      "Harness line 3",
      "Harness polished sentence three",
    );
    if (!nextDoc) return false;
    return window.__editorCommentsHarness?.replaceDocument?.(nextDoc);
  });
  expect(replaced).toBe(true);

  await expect(page.locator(".cm-inlineCommentMark")).toHaveCount(0);
  await expect(page.locator(".cm-inlineCommentSuperscript")).toHaveCount(0);
  await expect(page.locator(".cm-inlineCommentCard")).toContainText("H-1");
  await expect(
    page.getByRole("button", { name: "Expand point comment selection" }),
  ).toBeVisible();
  await expect(page.locator(".cm-inlineCommentText")).toHaveText(
    "Review this polished line.",
  );

  const state = await page.evaluate(() => {
    return window.__editorCommentsHarness?.getState?.();
  });
  expect(state?.markCount).toBe(0);
  expect(state?.cards).toEqual(["Review this polished line."]);
});

test("editor comments harness numbers multiple comments on the same row", async ({
  page,
}) => {
  await page.goto("/?debug=editor-comments", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-comments-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorCommentsHarness?.ready;
  });

  const selectedSecondSegment = await page.evaluate(() => {
    return window.__editorCommentsHarness?.selectTextInRow?.(
      "Harness line 3",
      "line 3",
    );
  });
  expect(selectedSecondSegment).toBe(true);

  await page.getByRole("button", { exact: true, name: "Comment" }).click();
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Second segment comment.");
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .press("Enter");

  const selectedFirstSegment = await page.evaluate(() => {
    return window.__editorCommentsHarness?.selectTextInRow?.(
      "Harness line 3",
      "Harness",
    );
  });
  expect(selectedFirstSegment).toBe(true);

  await page.getByRole("button", { exact: true, name: "Comment" }).click();
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("First segment comment.");
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .press("Enter");

  await expect(page.locator(".cm-inlineCommentSuperscript")).toHaveText([
    "H-2",
    "H-1",
  ]);
  await expect(page.locator(".cm-inlineCommentBadge")).toHaveText([
    "H-2",
    "H-1",
  ]);
  await expect(page.locator(".cm-inlineCommentText")).toHaveText([
    "First segment comment.",
    "Second segment comment.",
  ]);

  await page.evaluate(() => {
    document.querySelector(".cm-scroller")?.scrollTo({ top: 0 });
  });
  await page.getByRole("button", { name: "Scroll to comment H-1" }).click();

  const centered = await page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller");
    const secondCard = Array.from(
      document.querySelectorAll<HTMLElement>(".cm-inlineCommentCard"),
    ).find((card) => card.textContent?.includes("Second segment comment."));
    if (!(scroller instanceof HTMLElement) || !secondCard) return false;

    const scrollerRect = scroller.getBoundingClientRect();
    const cardRect = secondCard.getBoundingClientRect();
    return (
      Math.abs(
        cardRect.top +
          cardRect.height / 2 -
          (scrollerRect.top + scrollerRect.height / 2),
      ) <= 4
    );
  });
  expect(centered).toBe(true);
});

test("editor comments harness keeps comments anchored when highlighted text is deleted", async ({
  page,
}) => {
  await page.goto("/?debug=editor-comments", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-comments-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorCommentsHarness?.ready;
  });

  const selected = await page.evaluate(() => {
    return window.__editorCommentsHarness?.selectTextInRow?.(
      "Harness line 5",
      "line 5",
    );
  });
  expect(selected).toBe(true);

  await page.getByRole("button", { exact: true, name: "Comment" }).click();
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Keep this anchored.");
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .press("Enter");
  await expect(page.locator(".cm-inlineCommentMark")).toHaveCount(1);

  const deleted = await page.evaluate(() => {
    return window.__editorCommentsHarness?.replaceTextInRow?.(
      "Harness line 5",
      "line 5",
      "",
    );
  });
  expect(deleted).toBe(true);

  await expect(page.locator(".cm-inlineCommentMark")).toHaveCount(0);
  await expect(page.locator(".cm-inlineCommentSuperscript")).toHaveCount(0);
  await expect(page.locator(".cm-inlineCommentCard")).toContainText("H-1");
  await expect(
    page.getByRole("button", { name: "Expand point comment selection" }),
  ).toBeVisible();
  await expect(page.locator(".cm-inlineCommentText")).toHaveText(
    "Keep this anchored.",
  );
  await expect(page.locator(".cm-inlineCommentPlacementStatus")).toHaveText(
    "Lost",
  );
  await expect(
    page.getByRole("button", { name: "Edit comment", exact: true }),
  ).toHaveCount(0);
  await page.locator(".cm-content").press("ControlOrMeta+z");
  await expect(page.locator(".cm-inlineCommentMark")).toHaveCount(1);
  await expect(page.locator(".cm-inlineCommentPlacementStatus")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit comment", exact: true }),
  ).toBeVisible();
  await page.locator(".cm-content").press("ControlOrMeta+Shift+z");
  await expect(page.locator(".cm-inlineCommentPlacementStatus")).toHaveText(
    "Lost",
  );
});

test("undo restores a partially deleted or replaced highlight and persists it", async ({
  page,
}) => {
  const key = "catalex-harness-comments:/tmp/comment-harness";
  await page.addInitScript((key) => {
    if (!localStorage.getItem(key))
      localStorage.setItem(
        key,
        JSON.stringify({
          "main.tex": [
            {
              id: "undo-anchor",
              number: 1,
              from: 2,
              to: 9,
              line: 1,
              text: "Keep this range",
            },
          ],
        }),
      );
  }, key);
  await page.goto("/?debug=editor-comments");
  await expect(page.locator(".cm-inlineCommentMark")).toHaveText("Comment");
  const range = () =>
    page.evaluate((key) => {
      const comment = JSON.parse(localStorage.getItem(key)!)["main.tex"][0];
      return { from: comment.from, to: comment.to };
    }, key);
  for (const [segment, replacement] of [
    ["% Com", ""],
    ["% Comment harness", "replacement"],
  ]) {
    expect(
      await page.evaluate(
        ({ segment, replacement }) =>
          window.__editorCommentsHarness!.replaceTextInRow!(
            "% Comment harness",
            segment,
            replacement,
          ),
        { segment, replacement },
      ),
    ).toBe(true);
    await page.locator(".cm-content").focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator(".cm-inlineCommentMark")).toHaveText("Comment");
    await expect.poll(range).toEqual({ from: 2, to: 9 });
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(range).not.toEqual({ from: 2, to: 9 });
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(range).toEqual({ from: 2, to: 9 });
  }
  await page.screenshot({ path: "test-results/comment-anchor-undo.png" });
  await page.reload();
  await expect(page.locator(".cm-inlineCommentMark")).toHaveText("Comment");
  await expect.poll(range).toEqual({ from: 2, to: 9 });
});

test("editor comments harness excludes text inserted at highlight anchors", async ({
  page,
}) => {
  await page.goto("/?debug=editor-comments", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-comments-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorCommentsHarness?.ready;
  });

  const selected = await page.evaluate(() => {
    return window.__editorCommentsHarness?.selectTextInRow?.(
      "Harness line 6",
      "line 6",
    );
  });
  expect(selected).toBe(true);

  await page.getByRole("button", { exact: true, name: "Comment" }).click();
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Keep only original segment.");
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .press("Enter");

  const insertedAtStart = await page.evaluate(() => {
    return window.__editorCommentsHarness?.insertTextInRow?.(
      "Harness line 6",
      "Harness ".length,
      "new ",
    );
  });
  expect(insertedAtStart).toBe(true);

  const insertedAtEnd = await page.evaluate(() => {
    return window.__editorCommentsHarness?.insertTextInRow?.(
      "Harness new line 6",
      "Harness new line 6".length,
      "!",
    );
  });
  expect(insertedAtEnd).toBe(true);

  const markedText = await page.evaluate(() => {
    return document.querySelector(".cm-inlineCommentMark")?.textContent;
  });
  expect(markedText).toBe("line 6");
  await expect(page.locator(".cm-inlineCommentText")).toHaveText(
    "Keep only original segment.",
  );
});

test("offscreen text undo restores comment anchors before returning to the file", async ({
  page,
}) => {
  const key = "catalex-harness-comments:/tmp/comment-harness";
  await page.addInitScript(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          "main.tex": [
            {
              id: "offscreen",
              number: 1,
              from: 2,
              to: 9,
              line: 1,
              text: "Offscreen review",
            },
          ],
        }),
      ),
    key,
  );
  await page.goto("/?debug=editor-comments");
  await expect(page.locator(".cm-inlineCommentMark")).toHaveText("Comment");
  expect(
    await page.evaluate(() =>
      window.__editorCommentsHarness!.replaceTextInRow!(
        "% Comment harness",
        "% Com",
        "",
      ),
    ),
  ).toBe(true);
  await expect(page.locator(".cm-inlineCommentMark")).toHaveText("ment");
  await page.getByRole("button", { name: "figure.svg", exact: true }).click();
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const event = new CustomEvent("catalex-file-undo", {
        cancelable: true,
        detail: {
          root: "/tmp/comment-harness",
          filePath: "main.tex",
          redo: false,
        },
      });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const c = JSON.parse(localStorage.getItem(key)!)["main.tex"][0];
        return [c.from, c.to];
      }, key),
    )
    .toEqual([2, 9]);
  await page.getByRole("button", { name: "main.tex", exact: true }).click();
  await expect(page.locator(".cm-inlineCommentMark")).toHaveText("Comment");
});

test("sustained typing in a long document does not accumulate editor styles", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/?debug=editor-comments");
  await page.waitForFunction(() => window.__editorCommentsHarness?.ready);
  const source = "A research paragraph with Unicode: 中文 and 🧪.\n".repeat(
    2000,
  );
  await page.evaluate((text) => {
    window.__editorCommentsHarness?.replaceDocument?.(text);
    window.__editorCommentsHarness?.selectRange?.(0, 0);
  }, source);
  await page.keyboard.type("Warmup ");
  const styleSize = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll("style"))
        .filter((style) => style.textContent?.includes(".cm-inlineCommentCard"))
        .reduce((size, style) => size + (style.sheet?.cssRules.length ?? 0), 0),
    );
  const before = await styleSize();
  expect(before).toBeGreaterThan(0);
  const chunk = "More experimental results. ".repeat(10);
  for (let round = 0; round < 4; round++) {
    await page.keyboard.type(chunk);
    await expect.poll(styleSize).toBe(before);
  }
  await expect
    .poll(() =>
      page.evaluate(() => window.__editorCommentsHarness?.getState?.().docText),
    )
    .toBe(`Warmup ${chunk.repeat(4)}${source}`);
  await page.screenshot({
    path: test.info().outputPath("sustained-typing.png"),
  });
});

test("typing optimizations preserve Chinese composition @core", async ({
  page,
}) => {
  await page.goto("/?debug=editor-comments");
  await page.waitForFunction(() => window.__editorCommentsHarness?.ready);
  await page.evaluate(() => {
    window.__editorCommentsHarness?.replaceDocument?.("Research text");
    window.__editorCommentsHarness?.selectRange?.(0, 0);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "zhongwen",
    selectionStart: 8,
    selectionEnd: 8,
  });
  await cdp.send("Input.imeSetComposition", {
    text: "中文",
    selectionStart: 2,
    selectionEnd: 2,
  });
  await cdp.send("Input.insertText", { text: "中文" });
  await page.keyboard.type(" ");
  await expect
    .poll(() =>
      page.evaluate(() => window.__editorCommentsHarness?.getState?.().docText),
    )
    .toBe("中文 Research text");
  await cdp.detach();
});
