import { expect, test } from "@playwright/test";

test("pending comment controls stay local, preserve typing, and recover after failure", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "catalex-harness-comments:/tmp/comment-harness",
      JSON.stringify({
        "main.tex": [
          {
            id: "other",
            number: 1,
            from: 2,
            to: 17,
            line: 1,
            text: "Other comment",
          },
        ],
      }),
    );
  });
  await page.goto("/?debug=editor-comments");
  await page.waitForFunction(() => window.__editorCommentsHarness?.ready);
  await page.evaluate(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      commentSaveGate: { release: () => void; fail: boolean; started: boolean };
    };
    const original = host.__TAURI_INTERNALS__.invoke;
    let held = false;
    host.commentSaveGate = { release() {}, fail: false, started: false };
    host.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (!held && command.startsWith("update_project_comment")) {
        held = true;
        host.commentSaveGate.started = true;
        await new Promise<void>((resolve) => {
          host.commentSaveGate.release = resolve;
        });
      }
      if (
        command.startsWith("update_project_comment") &&
        host.commentSaveGate.fail
      )
        throw new Error("Injected save failure");
      return original(command, args);
    };
  });
  expect(
    await page.evaluate(() =>
      window.__editorCommentsHarness?.selectText?.("line 20"),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const input = page.getByRole("textbox", {
    name: "Comment text",
    exact: true,
  });
  await input.fill("Keep this draft after a failed save");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  const saving = page
    .locator(".cm-inlineCommentCard")
    .filter({ hasText: "Keep this draft" });
  const other = page.locator(
    '[data-inline-comment-id="other"].cm-inlineCommentCard',
  );
  await expect(
    saving.getByRole("status", { name: "Saving comment", exact: true }),
  ).toBeVisible();
  await expect(
    saving.getByRole("button", { name: "Delete comment", exact: true }),
  ).toBeDisabled();
  await expect(
    other.getByRole("button", { name: "Edit comment", exact: true }),
  ).toBeEnabled();
  await expect(saving).not.toHaveClass(/cm-inlineCommentCardTransitioning/);
  await page.screenshot({
    path: testInfo.outputPath("saving.png"),
    animations: "disabled",
  });
  // Document editing and anchor mapping continue while the comment request waits.
  const content = page.locator(".cm-editor .cm-content").first();
  await content.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.insertText("Prefix ");
  await expect(content).toContainText("Prefix ");
  await expect(
    other.getByRole("button", { name: "Edit comment", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    const host = window as unknown as {
      commentSaveGate: { release: () => void; fail: boolean };
    };
    host.commentSaveGate.fail = true;
    host.commentSaveGate.release();
  });
  await expect(page.getByText(/Comment changes were not saved/)).toBeVisible();
  await expect(
    saving.getByRole("status", { name: "Saving comment", exact: true }),
  ).toHaveCount(0);
  await expect(
    saving.getByRole("button", { name: "Edit comment", exact: true }),
  ).toBeEnabled();
  await expect(saving).toContainText("Keep this draft after a failed save");
  await page.evaluate(() => {
    (
      window as unknown as { commentSaveGate: { fail: boolean } }
    ).commentSaveGate.fail = false;
  });
  await page.getByRole("button", { name: "Retry saving", exact: true }).click();
  await expect(page.getByText(/Comment changes were not saved/)).toHaveCount(0);
  await saving
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await saving
    .getByRole("button", { name: "Confirm delete comment", exact: true })
    .click();
  await expect(saving).toHaveCount(0);
  await expect(other).toBeVisible();
});
