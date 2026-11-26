import { expect, test } from "@playwright/test";
const root = "/browser-demo/Comment Review";
const key = `catalex-harness-comments:${root}`;

test("an agent can reopen a resolved comment and undo that status change", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace");
  const card = page
    .locator('.cm-inlineCommentCard[data-inline-comment-id="A-7"]')
    .first();
  await expect(card).toBeVisible();
  const setStatus = (resolved: boolean) =>
    page.evaluate(
      async ({ root, key, resolved }) => {
        const before = JSON.parse(localStorage.getItem(key)!)[
          "manuscript.md"
        ].find((c: { id: string }) => c.id === "A-7");
        // @ts-expect-error Vite browser module
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        await invoke("update_project_comment", {
          projectRoot: root,
          patch: {
            filePath: "manuscript.md",
            id: before.id,
            before,
            after: { ...before, resolved },
          },
        });
      },
      { root, key, resolved },
    );
  await setStatus(true);
  await expect(card).toHaveCount(0);
  await setStatus(false);
  await expect(card).toBeVisible();
  await expect(card).toContainText("Explain the evaluation challenge.");
  await page.locator(".cm-editor .cm-content").first().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(card).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(card).toBeVisible();
  await page.screenshot({ path: "test-results/comment-reopened.png" });
});

test("a newly saved human comment keeps its number across undo and redo @core", async ({
  page,
}) => {
  await page.goto("/?debug=editor-comments");
  await page.waitForFunction(() => window.__editorCommentsHarness?.ready);
  await page.evaluate(() =>
    window.__editorCommentsHarness?.selectText?.("line 3"),
  );
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("New feedback");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  const key = "catalex-harness-comments:/tmp/comment-harness";
  const read = () =>
    page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "{}")["main.tex"]?.[0],
      key,
    );
  await expect.poll(async () => (await read())?.number).toBe(1);
  const original = await read();
  await page.locator(".cm-editor .cm-content").first().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(read).toBeUndefined();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await read())?.id).toBe(original.id);
  expect((await read()).number).toBe(1);
});

test("text and direct comment changes share undo/redo without review UI", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace");
  const editor = page.locator(".cm-editor").first();
  await expect(editor).toBeVisible();
  const content = editor.locator(".cm-content");
  // Comment cards are embedded in the content; its center may be a card.
  await content.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.insertText("Test ");
  await expect(content).toContainText("Test # Learning");
  // Simulate a backend notification after an agent's direct edit.
  await page.evaluate(
    async ({ key, root }) => {
      const files = JSON.parse(localStorage.getItem(key)!);
      const before = files["manuscript.md"][0];
      // @ts-expect-error Vite browser module
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      await invoke("update_project_comment", {
        projectRoot: root,
        patch: {
          filePath: "manuscript.md",
          id: before.id,
          before,
          after: { ...before, text: "Updated directly" },
        },
      });
    },
    { key, root },
  );
  const text = () =>
    page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!)["manuscript.md"][0].text,
      key,
    );
  await expect.poll(text).toBe("Updated directly");
  await expect(
    page.getByRole("region", { name: "Review proposed comment changes" }),
  ).toHaveCount(0);
  await content.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(text).not.toBe("Updated directly");
  await expect(content).toContainText("Test # Learning");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(content).not.toContainText("Test # Learning");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(content).toContainText("Test # Learning");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(text).toBe("Updated directly");
  await page.screenshot({ path: "test-results/comment-direct-undo.png" });
});

test("human comment controls undo edit, resolve and deletion with attribution intact", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace");
  const card = page
    .locator('.cm-inlineCommentCard[data-inline-comment-id="A-7"]')
    .first();
  await expect(card).toBeVisible();
  const read = () =>
    page.evaluate(
      (key) =>
        JSON.parse(localStorage.getItem(key)!)["manuscript.md"].find(
          (c: { id: string }) => c.id === "A-7",
        ),
      key,
    );
  const original = await read();
  await card.getByRole("button", { name: "Edit comment", exact: true }).click();
  await card.locator("textarea").fill("Human refinement of agent feedback");
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect
    .poll(async () => (await read()).text)
    .toBe("Human refinement of agent feedback");
  const content = page.locator(".cm-editor .cm-content").first();
  await content.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await read()).text).toBe(original.text);
  // Undo Save restores the unsaved draft; undo typing and save the original.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(card.locator("textarea")).toHaveValue(original.text);
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  for (const action of ["resolve", "delete"]) {
    await card
      .getByRole("button", {
        name: `${action === "resolve" ? "Resolve" : "Delete"} comment`,
        exact: true,
      })
      .click();
    await card
      .getByRole("button", { name: `Confirm ${action} comment`, exact: true })
      .click();
    await expect(card).toHaveCount(0);
    await content.focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(card).toBeVisible();
    expect(await read()).toMatchObject({
      id: original.id,
      text: original.text,
      origin: original.origin,
      number: original.number,
    });
    expect(Boolean((await read()).resolved)).toBe(false);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(card).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(card).toBeVisible();
  }
});

test("an agent edit to another file joins that file's history", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace");
  await expect(page.locator(".cm-editor").first()).toBeVisible();
  await page.evaluate(
    async ({ key, root }) => {
      const files = JSON.parse(localStorage.getItem(key)!);
      const before = files["review-notes.md"][0];
      // @ts-expect-error Vite browser module
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      await invoke("update_project_comment", {
        projectRoot: root,
        patch: {
          filePath: "review-notes.md",
          id: before.id,
          before,
          after: { ...before, text: "Updated in background" },
        },
      });
    },
    { key, root },
  );
  await page.getByText("review-notes.md", { exact: true }).first().dblclick();
  const content = page.locator(".cm-editor .cm-content").first();
  await expect(content).toContainText("# Review notes");
  await content.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem(key)!)["review-notes.md"][0].text,
        key,
      ),
    )
    .toBe("Define SSL on first use.");
});

test("a LaTeX document with 20 comments stays editable after delete-all and paste", async ({
  page,
  context,
}) => {
  const storage = "catalex-harness-comments:/tmp/comment-harness";
  await page.addInitScript((key) => {
    const comments = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      number: i + 1,
      from: i * 12,
      to: i * 12 + 4,
      line: 1,
      text: "Review passage",
    }));
    localStorage.setItem(key, JSON.stringify({ "main.tex": comments }));
  }, storage);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?debug=editor-comments");
  const content = page.locator(".cm-content");
  await expect(content.locator(".cm-inlineCommentCard").first()).toBeVisible();
  const doc = () =>
    page.evaluate(() => window.__editorCommentsHarness?.getState?.().docText);
  await page.evaluate(() =>
    navigator.clipboard.writeText("Replacement manuscript"),
  );
  await content.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await expect.poll(doc).toBe("");
  await page.keyboard.press("ControlOrMeta+v");
  await page.keyboard.type(" continues");
  await expect.poll(doc).toBe("Replacement manuscript continues");
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const comments = JSON.parse(localStorage.getItem(key)!)["main.tex"];
        return comments.filter(
          (c: { positionReset?: boolean; from: number; to: number }) =>
            c.positionReset &&
            c.from === "Replacement manuscript continues".length &&
            c.to === c.from,
        ).length;
      }, storage),
    )
    .toBe(20);
  // Collapsed handles share a caret. An idle view should not measure it
  // once per comment on every animation frame.
  const reads = await content.evaluate(async (element) => {
    // @ts-expect-error Vite browser module
    const { EditorView } = await import("/@id/@codemirror/view");
    const view = EditorView.findFromDOM(element);
    const original = view.coordsAtPos;
    let count = 0;
    view.coordsAtPos = function (position: number, side?: number) {
      count++;
      return original.call(this, position, side);
    };
    try {
      for (let frame = 0; frame < 8; frame++)
        await new Promise(requestAnimationFrame);
      return count;
    } finally {
      view.coordsAtPos = original;
    }
  });
  expect(reads).toBeLessThan(20);
});

test("a point comment handle follows its text while a card above changes height", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "catalex-harness-comments:/tmp/comment-harness",
      JSON.stringify({
        "main.tex": [
          { id: "a", number: 1, from: 80, to: 94, line: 5, text: "Range" },
          { id: "b", number: 2, from: 200, to: 200, line: 13, text: "Point" },
        ],
      }),
    );
  });
  await page.goto("/?debug=editor-comments");
  const card = page.locator(".cm-inlineCommentCard").first();
  await expect(card).toBeVisible();
  await expect(
    page.locator('[data-comment-range-handle="point"]'),
  ).toBeVisible();
  // Distance between the handle and the caret position it marks.
  const offset = () =>
    page.evaluate(async () => {
      // @ts-expect-error Vite browser module
      const { EditorView } = await import("/@id/@codemirror/view");
      const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
      // Read once this frame's updates have all run, in whatever order.
      for (let frame = 0; frame < 3; frame++)
        await new Promise(requestAnimationFrame);
      await new Promise((resolve) => setTimeout(resolve));
      return Math.round(
        document
          .querySelector('[data-comment-range-handle="point"]')!
          .getBoundingClientRect().top - view.coordsAtPos(200, 1).top,
      );
    });
  expect(await offset()).toBe(0);
  const before = await page.evaluate(async () => {
    // @ts-expect-error Vite browser module
    const { EditorView } = await import("/@id/@codemirror/view");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    return view.coordsAtPos(200, 1).top;
  });
  // The card grows on its own: no edit, no scroll, no editor transaction.
  await card.evaluate((element) => {
    element.style.transition = "padding-bottom 400ms linear";
    element.style.paddingBottom = "120px";
  });
  const during: number[] = [];
  for (let sample = 0; sample < 6; sample++) during.push(await offset());
  expect(during).toEqual([0, 0, 0, 0, 0, 0]);
  await page.waitForTimeout(500);
  expect(await offset()).toBe(0);
  const after = await page.evaluate(async () => {
    // @ts-expect-error Vite browser module
    const { EditorView } = await import("/@id/@codemirror/view");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    return view.coordsAtPos(200, 1).top;
  });
  expect(after - before).toBeGreaterThan(100);
});
