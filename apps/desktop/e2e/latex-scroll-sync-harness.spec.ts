import { expect, test } from "@playwright/test";

test("keeps LaTeX editor and PDF scrolling synchronized in both directions", async ({
  page,
}) => {
  await page.goto("/?debug=latex-scroll-sync", {
    waitUntil: "domcontentloaded",
  });

  const shell = page.getByTestId("latex-scroll-sync-harness-shell");
  await expect(shell).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("latex-editor-toolbar")).toBeVisible();
  await expect(page.getByTestId("latex-word-count")).toContainText("words");
  await expect(page.getByTestId("latex-character-count")).toContainText(
    "chars",
  );

  const lockButton = page.getByRole("button", {
    name: "Disable synchronized scrolling",
  });
  await expect(lockButton).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Locate PDF position" }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Locate editor position" }),
  ).toBeHidden();

  const editorScroller = page.locator(".cm-scroller");
  const pdfScroller = page.getByTestId("pdf-scroll-container");
  const viewCalls = page.getByTestId("synctex-view-calls");
  const editCalls = page.getByTestId("synctex-edit-calls");
  await expect(editorScroller).toBeVisible();
  await expect(pdfScroller).toBeVisible();
  await expect(page.locator(".mupdf-page")).toHaveCount(8);

  const viewCallsBeforeEditorScroll = Number(await viewCalls.textContent());
  await editorScroller.hover();
  await page.mouse.wheel(0, 2_400);
  await expect
    .poll(async () => Number(await viewCalls.textContent()))
    .toBeGreaterThan(viewCallsBeforeEditorScroll);
  await expect
    .poll(() => pdfScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);

  await page.waitForTimeout(500);
  const editCallsBeforePdfScroll = Number(await editCalls.textContent());
  const cursorBeforePdfScroll = Number(
    await page.getByTestId("latex-editor-cursor").textContent(),
  );
  const editorScrollBeforePdfScroll = await editorScroller.evaluate(
    (element) => element.scrollTop,
  );
  await pdfScroller.hover();
  await page.mouse.wheel(0, 1_800);
  await expect
    .poll(async () => Number(await editCalls.textContent()))
    .toBeGreaterThan(editCallsBeforePdfScroll);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(editorScrollBeforePdfScroll);
  await expect(page.getByTestId("latex-editor-cursor")).toHaveText(
    String(cursorBeforePdfScroll),
  );

  await lockButton.click();
  await expect(
    page.getByRole("button", { name: "Enable synchronized scrolling" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Locate PDF position" }),
  ).toBeEnabled();
  const viewCallsBeforeUnlockedScroll = Number(await viewCalls.textContent());
  await editorScroller.hover();
  await page.mouse.wheel(0, -1_200);
  await page.waitForTimeout(250);
  await expect(viewCalls).toHaveText(String(viewCallsBeforeUnlockedScroll));

  await page.screenshot({
    path: "test-results/latex-scroll-sync-harness.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Bold" }).click();
  await expect(page.locator(".cm-content")).toContainText("\\textbf{text}");
  await expect(page.getByTestId("latex-character-count")).toContainText("4/");
});

test("makes the PDF follow the editor after recompilation without reverse feedback", async ({
  page,
}) => {
  await page.goto("/?debug=latex-scroll-sync", {
    waitUntil: "domcontentloaded",
  });

  const shell = page.getByTestId("latex-scroll-sync-harness-shell");
  await expect(shell).toHaveAttribute("data-ready", "true");

  const editorScroller = page.locator(".cm-scroller");
  const pdfScroller = page.getByTestId("pdf-scroll-container");
  const viewCalls = page.getByTestId("synctex-view-calls");
  const editCalls = page.getByTestId("synctex-edit-calls");
  await expect(page.locator(".mupdf-page")).toHaveCount(8);

  await editorScroller.hover();
  await page.mouse.wheel(0, 2_400);
  await expect
    .poll(() => pdfScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);
  await page.waitForTimeout(500);

  const editorScrollBeforeCompile = await editorScroller.evaluate(
    (element) => element.scrollTop,
  );
  const viewCallsBeforeCompile = Number(await viewCalls.textContent());
  const editCallsBeforeCompile = Number(await editCalls.textContent());
  const cursorBeforeCompile = await page
    .getByTestId("latex-editor-cursor")
    .textContent();

  await page.getByTestId("simulate-latex-recompile").click();

  await expect
    .poll(async () => Number(await viewCalls.textContent()))
    .toBeGreaterThan(viewCallsBeforeCompile);
  await expect
    .poll(() => pdfScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);
  await page.waitForTimeout(600);

  expect(
    await editorScroller.evaluate((element) => element.scrollTop),
  ).toBeCloseTo(editorScrollBeforeCompile, 0);
  await expect(editCalls).toHaveText(String(editCallsBeforeCompile));
  await expect(page.getByTestId("latex-editor-cursor")).toHaveText(
    cursorBeforeCompile ?? "0",
  );
});

test("keeps the PDF-led reading position after recompilation without moving the cursor", async ({
  page,
}) => {
  await page.goto("/?debug=latex-scroll-sync");
  await expect(
    page.getByTestId("latex-scroll-sync-harness-shell"),
  ).toHaveAttribute("data-ready", "true");
  const pdf = page.getByTestId("pdf-scroll-container");
  const editor = page.locator(".cm-scroller");
  await expect(page.locator(".mupdf-page")).toHaveCount(8);
  await page.waitForTimeout(650);
  const editCalls = Number(
    await page.getByTestId("synctex-edit-calls").textContent(),
  );
  const cursor = await page.getByTestId("latex-editor-cursor").textContent();
  await pdf.hover();
  await page.mouse.wheel(0, 1_800);
  await expect
    .poll(async () =>
      Number(await page.getByTestId("synctex-edit-calls").textContent()),
    )
    .toBeGreaterThan(editCalls);
  await expect
    .poll(() => editor.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(500);
  await page.waitForTimeout(300);
  const editorBefore = await editor.evaluate((element) => element.scrollTop);
  const viewCalls = Number(
    await page.getByTestId("synctex-view-calls").textContent(),
  );
  await page.getByTestId("simulate-latex-recompile").click();
  await expect
    .poll(async () =>
      Number(await page.getByTestId("synctex-view-calls").textContent()),
    )
    .toBeGreaterThan(viewCalls);
  await expect
    .poll(() => pdf.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(1_000);
  await page.waitForTimeout(650);
  expect(await pdf.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    1_000,
  );
  expect(
    Math.abs(
      (await editor.evaluate((element) => element.scrollTop)) - editorBefore,
    ),
  ).toBeLessThan(2);
  await expect(page.getByTestId("latex-editor-cursor")).toHaveText(
    cursor ?? "0",
  );
  await page.screenshot({
    path: test.info().outputPath("pdf-led-recompile.png"),
  });
});

test("mutes continuous scrolling for every file in a multi-file LaTeX document", async ({
  page,
}) => {
  await page.goto("/?debug=latex-multifile-scroll-sync", {
    waitUntil: "domcontentloaded",
  });

  const shell = page.getByTestId("latex-scroll-sync-harness-shell");
  await expect(shell).toHaveAttribute("data-ready", "true");
  await expect(shell).toHaveAttribute("data-multi-file", "true");
  const mutedButton = page.getByRole("button", {
    name: "Synchronized scrolling unavailable for multi-file LaTeX document",
  });
  await expect(mutedButton).toBeDisabled();
  await expect(mutedButton).toHaveAttribute("data-scroll-sync-muted", "true");

  const locatePdfButton = page.getByRole("button", {
    name: "Locate PDF position",
  });
  const locateEditorButton = page.getByRole("button", {
    name: "Locate editor position",
  });
  await expect(locatePdfButton).toBeEnabled();
  await expect(locateEditorButton).toBeEnabled();

  const editorScroller = page.locator(".cm-scroller");
  const pdfScroller = page.getByTestId("pdf-scroll-container");
  const viewCalls = page.getByTestId("synctex-view-calls");
  const editCalls = page.getByTestId("synctex-edit-calls");
  await expect(page.locator(".mupdf-page")).toHaveCount(8);

  await editorScroller.hover();
  await page.mouse.wheel(0, 2_400);
  await page.waitForTimeout(200);
  await expect(viewCalls).toHaveText("0");

  await pdfScroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(200);
  await expect(editCalls).toHaveText("0");
  await expect(page.getByTestId("latex-active-file")).toHaveText("main.tex");

  await locateEditorButton.click();
  await expect
    .poll(async () => Number(await editCalls.textContent()))
    .toBeGreaterThan(0);
  await expect(page.getByTestId("latex-active-file")).toHaveText(
    "chapters/chapter-two.tex",
  );
  await expect(mutedButton).toBeDisabled();
  await page.waitForTimeout(1_000);
  await expect(
    page.locator('[data-problems-motion="bar"]').filter({
      has: page.locator('[data-problems-panel="true"]'),
    }),
  ).toHaveAttribute("data-open", "false");

  await page.screenshot({
    path: "test-results/latex-multifile-scroll-sync-muted.png",
    fullPage: true,
  });
});

test("temporary multi-file ineligibility preserves the saved scroll-sync choice", async ({
  page,
}) => {
  await page.goto("/?debug=latex-scroll-sync");
  await expect(
    page.getByTestId("latex-scroll-sync-harness-shell"),
  ).toHaveAttribute("data-ready", "true");
  const toggle = page.locator("[data-scroll-sync-muted]");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  for (const multiFile of [true, false]) {
    await page.evaluate(async (multiFile) => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      useDocumentStore.setState((state) => ({
        files: state.files.map((file) =>
          file.id === "main.tex"
            ? {
                ...file,
                content: multiFile
                  ? `${file.content}\n\\input{chapters/chapter-two}`
                  : file.content!.replace(
                      "\n\\input{chapters/chapter-two}",
                      "",
                    ),
              }
            : file,
        ),
      }));
    }, multiFile);
    await expect(toggle).toHaveAttribute(
      "data-scroll-sync-muted",
      String(multiFile),
    );
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  }
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveAttribute("data-scroll-sync-muted", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
});
