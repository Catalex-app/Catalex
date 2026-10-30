import { expect, test } from "@playwright/test";

for (const forceCommentFailure of [false, true]) {
  test(`stale comments preserve autosave (forced failure: ${forceCommentFailure})`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.addInitScript(() => {
      localStorage.setItem(
        "catalex-harness-comments:/tmp/comment-harness",
        JSON.stringify({
          "main.tex": [
            {
              id: "stale-resolved",
              number: 1,
              from: 139686,
              to: 139686,
              line: 1772,
              text: "Resolved old note",
              resolved: true,
            },
            {
              id: "stale-agent",
              number: 2,
              from: 138191,
              to: 138352,
              line: 1700,
              text: "Active old note",
              origin: { provider: "codex", sessionId: "test" },
            },
          ],
        }),
      );
    });
    if (forceCommentFailure) {
      await page.route("**/inline-comments.ts*", async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        const modified = body.replace(
          /(function commentsAfterEditorUpdate\([^)]*\)\s*\{)/,
          '$1 throw new Error("Injected comment mapping failure");',
        );
        expect(modified).not.toBe(body);
        await route.fulfill({ response, body: modified });
      });
    }
    await page.goto("/?debug=editor-comments");
    await expect(
      page.getByRole("button", { name: "Show comments: 0 human, 1 agent" }),
    ).toBeVisible();
    await page.evaluate(() => {
      const bridge = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (
              command: string,
              args?: Record<string, unknown>,
            ) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      const original = bridge.invoke;
      bridge.invoke = async (command, args) =>
        command === "save_file_if_unchanged"
          ? { written: true, current: args?.content }
          : original(command, args);
    });
    const before = await page.evaluate(
      () => window.__editorCommentsHarness!.getState!().contentGeneration,
    );
    await page.evaluate(() =>
      window.__editorCommentsHarness!.insertTextInRow!(
        "Harness line 1",
        0,
        "Recovered edit ",
      ),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__editorCommentsHarness!.getState!().storedText,
        ),
      )
      .toContain("Recovered edit Harness line 1");
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__editorCommentsHarness!.getState!().contentGeneration,
        ),
      )
      .toBeGreaterThan(before);
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__editorCommentsHarness!.getState!().isDirty,
        ),
      )
      .toBe(false);
    if (forceCommentFailure) {
      await expect(
        page.getByText(
          "Your edit is preserved, but comment positions could not be updated.",
        ),
      ).toBeVisible();
      await page.screenshot({
        path: "/tmp/catalex-comment-failure-warning.png",
      });
    }
    expect(
      errors.filter((message) => /out of range|update listener/i.test(message)),
    ).toEqual([]);
  });
}
