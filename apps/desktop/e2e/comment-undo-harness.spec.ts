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

test("a newly saved human comment keeps its number across undo and redo", async ({
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
