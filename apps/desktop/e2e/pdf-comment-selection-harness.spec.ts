import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 1000 } });

async function selectFormattedText(page: Page, backwards = false) {
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Your abstract here." })
    .first();
  await expect(line).toBeVisible();
  await line.evaluate((element, backwards) => {
    const node = element.firstChild!;
    const text = node.textContent!;
    const start = text.indexOf("Your");
    const end = text.indexOf("abstract") + "abstract".length;
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.setBaseAndExtent(
      node,
      backwards ? end : start,
      node,
      backwards ? start : end,
    );
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, backwards);
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible();
}

for (const backwards of [false, true]) {
  test(`creates an exact comment across formatting with delayed source lookup (${backwards ? "backward" : "forward"})`, async ({
    page,
  }) => {
    await page.goto("/?debug=pdf-comments&formatted&delayed-source");
    await page
      .getByRole("button", { name: "Toggle editor", exact: true })
      .click();
    await selectFormattedText(page, backwards);
    const commentButton = page.getByRole("button", {
      name: "Comment",
      exact: true,
    });
    await expect(commentButton).toBeDisabled();
    await expect(commentButton).toHaveAttribute("aria-busy", "true");
    await expect(commentButton).toBeEnabled();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
    const editor = card.getByRole("textbox", {
      name: "Comment text",
      exact: true,
    });
    await expect(editor).toBeVisible();
    await editor.fill("Selection mapping verified");
    await card
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const stored = JSON.parse(
            localStorage.getItem(
              "catalex-harness-comments:/tmp/catalex-pdf-comments-harness",
            ) ?? "{}",
          );
          return stored["chapter.tex"]?.filter(
            (comment: { text: string }) =>
              comment.text === "Selection mapping verified",
          );
        }),
      )
      .toMatchObject([
        {
          from: Array.from(
            { length: 80 },
            (_, i) => `% Source context ${i}\n`,
          ).join("").length,
          to:
            Array.from(
              { length: 80 },
              (_, i) => `% Source context ${i}\n`,
            ).join("").length + String.raw`Your \emph{abstract}`.length,
          line: 81,
        },
      ]);
    await expect(
      page.getByText("Could not confidently match this selection", {
        exact: false,
      }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("formatted-comment.png"),
    });
  });
}

test("dismissal cancels a pending comment lookup", async ({ page }) => {
  await page.goto("/?debug=pdf-comments&formatted&delayed-source");
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  await selectFormattedText(page);
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  await expect(
    page.getByRole("dialog", { name: "PDF comment", exact: true }),
  ).toHaveCount(0);
});

test("automatically chooses a tied match and reveals its source from the notice", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&formatted&auto-match");
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  await selectFormattedText(page);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
  const editor = card.getByRole("textbox", {
    name: "Comment text",
    exact: true,
  });
  await expect(editor).toBeVisible();
  await expect(
    page.getByText("Matched approximately—check the highlighted source.", {
      exact: true,
    }),
  ).toBeVisible();
  await editor.fill("Auto-picked source verified");
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  await page.getByRole("button", { name: "Show source", exact: true }).click();
  const sourceEditor = page.locator(".cm-editor").first();
  await expect(sourceEditor).toContainText("Your ");
  await expect(
    sourceEditor
      .locator(".cm-inlineCommentText")
      .filter({ hasText: "Auto-picked source verified" }),
  ).toBeVisible();
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    ),
  );
  await page.screenshot({
    path: test.info().outputPath("approximate-source.png"),
  });
});

test("comments on a generated list number through the following ellipses", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&lists");
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  // Closing the editor changes PDF fit-to-width. Select after that layout has
  // settled; scrolling a text node at the old scale can move it offscreen.
  await page.evaluate(async () => {
    await Promise.allSettled(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "and like this." })
    .first();
  await expect(line).toBeVisible();
  await page.getByTestId("pdf-scroll-container").focus();
  await line.scrollIntoViewIfNeeded();
  await line.evaluate((element) => {
    const lines = [
      ...element.closest(".mupdf-text-layer")!.querySelectorAll("text"),
    ];
    const end = lines.find((line) =>
      line.textContent?.includes("or bullet points"),
    )!;
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(
      element.firstChild!,
      0,
      end.firstChild!,
      end.firstChild!.textContent!.length,
    );
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
  await card
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("List selection verified");
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(card.getByText("List selection verified")).toBeVisible();
  await line.scrollIntoViewIfNeeded();
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    ),
  );
  await page.screenshot({ path: test.info().outputPath("list-comment.png") });
});

test("creates a comment across bounded generated text with an approximate notice", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&generated-gap");
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Your abstract here." })
    .first();
  await expect(line).toBeVisible();
  await line.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(
    page.getByText("Matched approximately—check the highlighted source."),
  ).toBeVisible();
  const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
  await card
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Generated text verified");
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  await line.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("generated-gap.png") });
});

test("unmatched selection shows unavailable without opening a comment", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&unmatched-source");
  await selectFormattedText(page);
  const button = page.getByRole("button", { name: "Comment", exact: true });
  await button.hover();
  await expect(
    page.getByRole("tooltip", {
      name: "Couldn’t locate the source. Select more surrounding text.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(button).not.toHaveAttribute("aria-busy", "true");
  await page.screenshot({
    path: test.info().outputPath("unavailable-comment.png"),
  });
  await expect(
    page.getByRole("dialog", { name: "PDF comment", exact: true }),
  ).toHaveCount(0);
});

test("returning focus to the editor dismisses the PDF toolbar", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments");
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Shift+ArrowRight");
  await page.getByTestId("pdf-scroll-container").focus();
  await selectFormattedText(page);
  await editor.click();
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toHaveCount(0);
  await page.getByTestId("pdf-scroll-container").focus();
  await selectFormattedText(page);
  await editor.focus();
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("[data-selection-toolbar]")).toHaveCount(0);
  await page.waitForTimeout(300); // Allow WebKit to paint the removed portal.
  await page.screenshot({ path: test.info().outputPath("editor-focus.png") });
});

test("PDF selection survives blur and returns on refocus", async ({ page }) => {
  await page.goto("/?debug=pdf-comments");
  const viewport = page.getByTestId("pdf-scroll-container");
  const editor = page.locator(".cm-content");
  await viewport.focus();
  await selectFormattedText(page);
  await editor.focus();
  await expect(page.locator("[data-selection-toolbar]")).toHaveCount(0);
  await expect(page.locator(".pdf-selection-highlight").first()).toHaveCSS(
    "fill",
    "rgba(140, 140, 140, 0.25)",
  );
  await viewport.focus();
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("Your abstract");
  await page.screenshot({ path: test.info().outputPath("pdf-refocused.png") });
  await page.keyboard.press("Escape");
  await editor.focus();
  await viewport.focus();
  await expect(page.locator("[data-selection-toolbar]")).toHaveCount(0);
  await expect(page.locator(".pdf-selection-highlight")).toHaveCount(0);
});

test("chat badge follows PDF and editor selections without requiring a source match", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&unmatched-source&mode=duet");
  await page
    .getByRole("button", { name: "Toggle chat drawer", exact: true })
    .click();
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(
    page.getByText(/@main\.tex:\d+:\d+-\d+:\d+/).first(),
  ).toBeVisible();
  await page.getByTestId("pdf-scroll-container").focus();
  await selectFormattedText(page);
  await expect(
    page.getByText("PDF p.1 · “Your abstract”", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/@main\.tex:\d+:\d+-\d+:\d+/)).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __pdfChatDraft?: () => unknown }
        ).__pdfChatDraft?.(),
      ),
    )
    .toMatchObject([
      { label: "PDF p.1 · “Your abstract”", selectedText: "Your abstract" },
    ]);
  await page.screenshot({ path: test.info().outputPath("pdf-chat-badge.png") });
  const composer = page.locator("[data-chat-composer-input]:visible");
  await composer.click();
  await composer.fill("Explain the selected passage");
  await composer.press("ControlOrMeta+a");
  await expect(page.locator("[data-selection-toolbar]")).toHaveCount(0);
  await expect(page.locator(".pdf-selection-highlight").first()).toHaveCSS(
    "fill",
    "rgba(140, 140, 140, 0.25)",
  );
  await expect(
    page.getByText("PDF p.1 · “Your abstract”", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __pdfChatDraft?: () => unknown }
        ).__pdfChatDraft?.(),
      ),
    )
    .toMatchObject([
      { label: "PDF p.1 · “Your abstract”", selectedText: "Your abstract" },
    ]);
  await page.screenshot({
    path: test.info().outputPath("pdf-selection-chat-focus.png"),
  });
  await page.getByTestId("pdf-scroll-container").focus();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("Your abstract");
  await expect(composer).toHaveValue("Explain the selected passage");
  await editor.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(
    page.getByText("PDF p.1 · “Your abstract”", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/@main\.tex:\d+:\d+-\d+:\d+/).first(),
  ).toBeVisible();
  await page.getByTestId("pdf-scroll-container").focus();
  await selectFormattedText(page);
  await expect(
    page.getByText("PDF p.1 · “Your abstract”", { exact: true }),
  ).toBeVisible();
});

test("PDF chat context reuses the matched source range", async ({ page }) => {
  await page.goto("/?debug=pdf-comments&formatted&mode=duet");
  await page
    .getByRole("button", { name: "Toggle chat drawer", exact: true })
    .click();
  await page.getByTestId("pdf-scroll-container").focus();
  await selectFormattedText(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as Window & { __pdfChatDraft?: () => unknown }
        ).__pdfChatDraft?.(),
      ),
    )
    .toMatchObject([
      {
        label: expect.stringMatching(/^PDF p\.1 · @chapter\.tex:81:1-81:\d+$/),
        filePath: "chapter.tex",
        selectedText: expect.stringMatching(
          /^Your abstract\n\n\[Source: chapter\.tex, line 81, offsets /,
        ),
      },
      { filePath: "chapter.tex", comment: { id: "human-pdf", agent: false } },
      { filePath: "chapter.tex", comment: { id: "agent-pdf", agent: true } },
    ]);
  await page.screenshot({
    path: test.info().outputPath("mapped-pdf-badge.png"),
  });
});

test("new selections clear the other pane, while focus alone preserves them", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments");
  const editor = page.locator(".cm-content");
  const pdf = page.getByTestId("pdf-scroll-container");
  await editor.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  const editorRange = () =>
    page.evaluate(async () => {
      const el = document.querySelector(".cm-editor")!;
      const modulePath = "/node_modules/.vite/deps/@codemirror_view.js";
      const { EditorView } = await import(modulePath);
      return EditorView.findFromDOM(el)?.state.selection.main.empty;
    });
  await expect.poll(editorRange).toBe(false);
  await pdf.focus();
  await expect.poll(editorRange).toBe(false);
  await selectFormattedText(page);
  await expect.poll(editorRange).toBe(true);
  await editor.focus();
  await expect(page.locator(".pdf-selection-highlight").first()).toBeVisible();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator(".pdf-selection-highlight")).toHaveCount(0);
  await pdf.focus();
  await expect(page.locator("[data-selection-toolbar]")).toHaveCount(0);
  await expect(page.locator(".pdf-selection-highlight")).toHaveCount(0);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: test.info().outputPath("exclusive-selection.png"),
  });
});

test("first click back into PDF restores selection; the next click clears it", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments");
  const pdf = page.getByTestId("pdf-scroll-container");
  await pdf.focus();
  await selectFormattedText(page);
  await page.locator(".cm-content").focus();
  await expect(page.locator("[data-selection-toolbar]")).toHaveCount(0);
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Your abstract here." })
    .first();
  const box = await line.boundingBox();
  await page.mouse.click(box!.x + 4, box!.y + box!.height / 2);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("Your abstract");
  await expect(
    page.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: test.info().outputPath("pdf-click-refocus.png"),
  });
  await page.mouse.click(box!.x + 4, box!.y + box!.height / 2);
  await expect(page.locator(".pdf-selection-highlight")).toHaveCount(0);
  await expect(page.locator("[data-selection-toolbar]")).toHaveCount(0);
});

for (const pane of ["editor", "pdf"] as const) {
  test(`removing the ${pane} badge clears selection permanently across refocus`, async ({
    page,
  }) => {
    await page.goto("/?debug=pdf-comments&unmatched-source&mode=duet");
    await page
      .getByRole("button", { name: "Toggle chat drawer", exact: true })
      .click();
    const editor = page.locator(".cm-content");
    const pdf = page.getByTestId("pdf-scroll-container");
    const source = pane === "editor" ? editor : pdf;
    const other = pane === "editor" ? pdf : editor;
    const chip = page.locator(
      '[data-chat-drawer-panel="true"] [data-selection-chip="true"]:visible',
    );
    const editorEmpty = () =>
      page.evaluate(async () => {
        const modulePath = "/node_modules/.vite/deps/@codemirror_view.js";
        const { EditorView } = await import(modulePath);
        return EditorView.findFromDOM(document.querySelector(".cm-editor")!)
          ?.state.selection.main.empty;
      });
    if (pane === "editor") {
      await editor.click();
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+ArrowRight");
      await expect.poll(editorEmpty).toBe(false);
    } else {
      await pdf.focus();
      await selectFormattedText(page);
      await expect(
        page.locator(".pdf-selection-highlight").first(),
      ).toBeVisible();
    }
    await expect(chip).toHaveCount(1);
    await other.focus();
    await source.focus();
    await expect(chip).toHaveCount(1);
    // Invoke the button while the source retains focus as well as its range.
    await chip
      .getByRole("button", { name: "Remove context" })
      .evaluate((element: HTMLButtonElement) => element.click());
    await expect(chip).toHaveCount(0);
    await expect.poll(editorEmpty).toBe(true);
    await expect(page.locator(".pdf-selection-highlight")).toHaveCount(0);
    await other.focus();
    await source.focus();
    // Let the PDF's debounced selection callback run before checking restoration.
    await page.waitForTimeout(400);
    await expect(chip).toHaveCount(0);
    await expect.poll(editorEmpty).toBe(true);
    await expect(page.locator(".pdf-selection-highlight")).toHaveCount(0);
    await expect(page.locator("[data-selection-toolbar]")).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`${pane}-badge-removed.png`),
    });
  });
}

test("PDF live context clears on deselection while pinned context survives", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&unmatched-source&mode=duet");
  await page
    .getByRole("button", { name: "Toggle chat drawer", exact: true })
    .click();
  const chips = page.locator(
    '[data-chat-drawer-panel="true"] [data-selection-chip="true"]:visible',
  );
  const preview = page.getByTestId("pdf-scroll-container");
  await preview.focus();
  await selectFormattedText(page);
  await expect(chips).toHaveCount(1);
  await page
    .locator('[data-chat-drawer-panel="true"] textarea:visible')
    .fill("Explain this passage");
  await expect(chips).toHaveCount(1);
  await preview.focus();
  await page.keyboard.press("Escape");
  await expect(chips).toHaveCount(0);
  await selectFormattedText(page);
  await expect(chips).toHaveCount(1);
  await chips
    .getByRole("button", { name: "Pin selection", exact: true })
    .click();
  await preview.focus();
  await page.keyboard.press("Escape");
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveAttribute("data-selection-pinned", "true");
  await page.screenshot({
    path: test.info().outputPath("pinned-pdf-context.png"),
  });
});

test("pinning PDF text before source lookup finishes does not duplicate context", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&formatted&delayed-source&mode=duet");
  await page
    .getByRole("button", { name: "Toggle chat drawer", exact: true })
    .click();
  await page.getByTestId("pdf-scroll-container").focus();
  await selectFormattedText(page);
  const chips = page.locator(
    '[data-chat-drawer-panel="true"] [data-selection-chip="true"]:visible',
  );
  await chips
    .getByRole("button", { name: "Pin selection", exact: true })
    .click();
  // The harness deliberately delays source resolution by 1200 ms.
  await page.waitForTimeout(1600);
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveAttribute("data-selection-pinned", "true");
});

test("split-view draft has one editor and preserves its source anchor", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&formatted&delayed-source");
  await selectFormattedText(page);
  const create = page.getByRole("button", { name: "Comment", exact: true });
  await expect(create).toBeEnabled();
  await create.click();
  const input = page.getByRole("textbox", {
    name: "Comment text",
    exact: true,
  });
  await expect(input).toHaveCount(1);
  await expect(input).toBeFocused();
  await expect(
    page.getByRole("dialog", { name: "PDF comment", exact: true }),
  ).toHaveCount(0);
  await input.pressSequentially("Stable human comment", { delay: 30 });
  await expect(input).toHaveValue("Stable human comment");
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stored = JSON.parse(
          localStorage.getItem(
            "catalex-harness-comments:/tmp/catalex-pdf-comments-harness",
          ) ?? "{}",
        );
        return stored["chapter.tex"]?.filter(
          (c: { text: string }) => c.text === "Stable human comment",
        );
      }),
    )
    .toMatchObject([
      {
        from: Array.from(
          { length: 80 },
          (_, i) => `% Source context ${i}\n`,
        ).join("").length,
        to:
          Array.from({ length: 80 }, (_, i) => `% Source context ${i}\n`).join(
            "",
          ).length + String.raw`Your \emph{abstract}`.length,
        line: 81,
      },
    ]);
  await page.screenshot({
    path: test.info().outputPath("split-comment-saved.png"),
  });
});

test("source-created draft never opens a second PDF input", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&formatted");
  await expect(page.locator(".mupdf-text-layer text").first()).toBeVisible();
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => url.includes("/stores/document-store.ts"))!;
    const { useDocumentStore } = await import(url);
    useDocumentStore.getState().setActiveFile("chapter.tex");
  });
  await expect(page.locator(".cm-editor")).toBeVisible();
  await expect(page.locator(".mupdf-text-layer text").first()).toBeVisible();
  const range = await page.evaluate(async () => {
    const modulePath = "/node_modules/.vite/deps/@codemirror_view.js";
    const { EditorView } = await import(modulePath);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    const from = view.state.doc.toString().indexOf("Your");
    if (from < 0) throw new Error("Missing source fixture");
    view.dispatch({
      selection: { anchor: from, head: from + 4 },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    view.focus();
    return { from, to: from + 4 };
  });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const input = page.getByRole("textbox", {
    name: "Comment text",
    exact: true,
  });
  await expect(input).toHaveCount(1);
  await expect(input).toBeFocused();
  await input.pressSequentially("Editor-origin note", { delay: 40 });
  await expect(input).toHaveValue("Editor-origin note");
  await expect(input).toBeFocused();
  await expect(
    page.getByRole("dialog", { name: "PDF comment", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = JSON.parse(
          localStorage.getItem(
            "catalex-harness-comments:/tmp/catalex-pdf-comments-harness",
          ) ?? "{}",
        );
        return saved["chapter.tex"]?.find(
          (c: { text: string }) => c.text === "Editor-origin note",
        );
      }),
    )
    .toMatchObject(range);
  await page.screenshot({
    path: test.info().outputPath("source-comment-saved.png"),
  });
});

test("canceling a PDF draft in the source removes its PDF marker", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&formatted&delayed-source");
  await selectFormattedText(page);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const input = page.getByRole("textbox", {
    name: "Comment text",
    exact: true,
  });
  await expect(input).toHaveCount(1);
  await page
    .getByRole("button", { name: "Cancel comment", exact: true })
    .click();
  await expect(input).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Show human comment: ", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "PDF comment", exact: true }),
  ).toHaveCount(0);
});
