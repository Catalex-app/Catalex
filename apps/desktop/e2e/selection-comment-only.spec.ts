import { expect, test } from "@playwright/test";

for (const mode of ["artisan", "duet"]) {
  for (const source of ["editor", "pdf"]) {
    test(`${mode} ${source} selection offers only Comment`, async ({
      page,
    }) => {
      if (source === "editor") {
        await page.goto(
          `/?debug=editor-comments${mode === "artisan" ? "&artisan" : ""}`,
        );
        await page.waitForFunction(
          () => !!window.__editorCommentsHarness?.ready,
        );
        await page.evaluate(() =>
          window.__editorCommentsHarness?.selectText?.("line 3"),
        );
        // Diagnostics arriving after selection must not add an AI action.
        await page.evaluate(async () => {
          const path = "/src/renderer/stores/document-store.ts";
          const store = (await import(path)).useDocumentStore;
          const file = store.getState().activeFileId;
          store.setState({
            compileDiagnosticsCache: new Map([
              [
                file,
                [
                  {
                    file,
                    line: 3,
                    severity: "error",
                    message: "Selection fixture issue",
                  },
                ],
              ],
            ]),
          });
        });
      } else {
        await page.goto(`/?debug=pdf-comments&formatted&mode=${mode}`);
        const line = page
          .locator(".mupdf-text-layer text")
          .filter({ hasText: "Your abstract here." })
          .first();
        await expect(line).toBeVisible();
        await line.evaluate((element) => {
          const node = element.firstChild!;
          const start = node.textContent!.indexOf("Your");
          window
            .getSelection()!
            .setBaseAndExtent(
              node,
              start,
              node,
              start + "Your abstract".length,
            );
          element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
      }
      const toolbar = page.locator("[data-selection-toolbar]");
      await expect(toolbar).toBeVisible();
      await toolbar.hover();
      await expect(toolbar.getByRole("button")).toHaveCount(1);
      const comment = toolbar.getByRole("button", {
        name: "Comment",
        exact: true,
      });
      await expect(comment).toBeEnabled();
      await toolbar.screenshot({
        path: test.info().outputPath(`${mode}-${source}-selection.png`),
        animations: "disabled",
      });
      await comment.click();
      await expect(
        page.getByRole("textbox", { name: "Comment text", exact: true }),
      ).toBeVisible();
    });
  }
}
