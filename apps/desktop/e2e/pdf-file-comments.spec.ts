import { expect, type Page, test } from "@playwright/test";

async function openStandalonePdf(page: Page) {
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible({
    timeout: 30_000,
  });
  await page.evaluate(async () => {
    const { useDocumentStore: doc, getPdfBytes } = await import(
      /* @vite-ignore */ "/src/renderer/stores/document-store.ts"
    );
    const bytes = getPdfBytes("sample.tex");
    const host = (window as any).__TAURI_INTERNALS__;
    const invoke = host.invoke.bind(host);
    host.invoke = (command: string, args: any, ...rest: any[]) =>
      command === "plugin:fs|read_file" && args.path.endsWith("/paper.pdf")
        ? Promise.resolve(bytes)
        : invoke(command, args, ...rest);
    const file = {
      ...doc.getState().files.find((file: any) => file.id === "sample.tex"),
      id: "paper.pdf",
      name: "paper.pdf",
      relativePath: "paper.pdf",
      absolutePath: "/demo/paper.pdf",
      type: "pdf",
      content: "",
    };
    doc.setState({ files: [...doc.getState().files, file] });
    doc.getState().setActiveFile(file.id);
  });
  await expect(page.getByTestId("pdf-scroll-container")).toHaveCount(1);
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page.waitForTimeout(700);
}

async function selectPdfText(
  page: Page,
  passage: string,
  selectedText?: string,
) {
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: passage })
    .first();
  await line.scrollIntoViewIfNeeded();
  await page.getByTestId("pdf-scroll-container").focus();
  await line.evaluate((el, text) => {
    const range = document.createRange();
    if (text) {
      const node = el.firstChild!;
      const start = node.textContent!.indexOf(text);
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
    } else {
      range.selectNodeContents(el);
    }
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, selectedText ?? null);
}

async function addComment(page: Page, text: string) {
  await selectPdfText(page, "Your abstract here.");
  return saveSelectedPdfComment(page, text);
}

async function saveSelectedPdfComment(page: Page, text: string) {
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
  await card
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill(text);
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(card.getByText(text, { exact: true })).toBeVisible();
  return card;
}

test("standalone PDF handles resize a multiline highlight and keep its comment", async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openStandalonePdf(page);
  const first = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Your abstract here." })
    .first();
  const second = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "can compare learning methods" })
    .first();
  await first.scrollIntoViewIfNeeded();
  await page.getByTestId("pdf-scroll-container").focus();
  await first.evaluate((element) => {
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(
      element.firstChild!,
      5,
      element.nextElementSibling!.firstChild!,
      24,
    );
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await saveSelectedPdfComment(page, "Resize this passage");
  const start = page.getByRole("button", { name: "Resize comment start" });
  const end = page.getByRole("button", { name: "Resize comment end" });
  await expect(start).toBeVisible();
  await expect(end).toBeVisible();

  const read = () =>
    page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([key]) => key.startsWith("catalex-harness-comments:"))
        .flatMap(([, value]) => JSON.parse(value)["paper.pdf"] ?? []),
    );
  await expect.poll(async () => (await read()).length).toBe(1);
  const [original] = await read();
  expect(original.pdf.regions).toHaveLength(2);
  const grab = async (handle: typeof start) => {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    return box;
  };
  const dragTo = async (line: typeof first, index: number) => {
    const point = await line.evaluate((element, i) => {
      const text = element as SVGTextElement;
      const x = text.getStartPositionOfChar(i).x;
      const glyph = text.getExtentOfChar(i);
      const point = new DOMPoint(x, glyph.y + glyph.height / 2).matrixTransform(
        text.getScreenCTM()!,
      );
      return { x: point.x, y: point.y };
    }, index);
    await page.mouse.move(point.x, point.y, { steps: 8 });
  };
  const initialStart = await grab(start);
  await dragTo(first, 0);
  await expect
    .poll(async () => (await start.boundingBox())!.x)
    .toBeLessThan(initialStart.x - 2);
  expect((await read())[0].pdf).toEqual(original.pdf);
  await page.screenshot({
    path: info.outputPath("standalone-pdf-resize-preview.png"),
    animations: "disabled",
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await read())[0].pdf.text)
    .toMatch(/^Your abstract/);
  await expect(end).toBeVisible();

  const initialEnd = await grab(end);
  await dragTo(second, 11);
  await expect
    .poll(async () => (await end.boundingBox())!.x)
    .toBeLessThan(initialEnd.x - 2);
  await page.mouse.up();
  await expect
    .poll(async () => (await read())[0].pdf.text)
    .toMatch(/\ncan compare$/);
  const [resized] = await read();
  expect(resized).toMatchObject({
    id: original.id,
    text: original.text,
    number: original.number,
  });
  expect(resized.pdf.regions).toHaveLength(2);
  expect(resized.pdf.fingerprint).toBe(original.pdf.fingerprint);

  await expect(end).toBeVisible();
  await grab(end);
  await dragTo(second, 20);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect((await read())[0].pdf).toEqual(resized.pdf);

  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      /* @vite-ignore */ "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.getState().setActiveFile("sample.tex");
  });
  await page
    .getByRole("button", { name: "paper.pdf", exact: true })
    .first()
    .click();
  const highlights = page.locator(
    `[data-pdf-comment-highlight][data-pdf-comment-id="${original.id}"]`,
  );
  await expect(highlights).toHaveCount(2);
  await highlights
    .first()
    .evaluate((element) => (element as HTMLElement).click());
  await expect(start).toBeVisible();
  await expect(end).toBeVisible();
  expect(await read()).toEqual([resized]);

  await grab(end);
  const nextPage = page.locator('.mupdf-page[data-page-number="2"]');
  await nextPage.evaluate((element) =>
    element.scrollIntoView({ block: "start" }),
  );
  const nextLine = nextPage
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Small-data learning" })
    .first();
  await expect(nextLine).toBeVisible();
  await dragTo(nextLine, 10);
  await expect(
    nextPage.getByRole("button", { name: "Resize comment end" }),
  ).toBeVisible();
  expect(await read()).toEqual([resized]);
  await page.mouse.up();
  await expect
    .poll(async () => (await read())[0].pdf.regions.at(-1).page)
    .toBe(2);
  expect((await read())[0].id).toBe(original.id);
});

test("standalone PDF text selection shows overlapping comment badges and preserves pins", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStandalonePdf(page);
  await addComment(page, "Clarify this PDF passage");
  const scroller = page.getByTestId("pdf-scroll-container");
  const clearSelection = () => scroller.press("Escape");
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  const excerpt = drawer.locator('[data-selection-chip="true"]');
  const comment = drawer.locator('[data-comment-chip="true"]');

  await expect(excerpt).toHaveCount(0);
  await expect(comment).toHaveCount(0);
  await scroller.click({ position: { x: 10, y: 10 } });
  await selectPdfText(page, "Introduction");
  await expect(excerpt).toHaveCount(1);
  await expect(comment).toHaveCount(0);

  await selectPdfText(page, "Your abstract here.", "abstract");
  await expect(excerpt).toHaveCount(1);
  await expect(comment).toHaveCount(1);
  await expect(comment).toContainText(/H-\d+ · paper\.pdf/);
  await page.screenshot({
    path: info.outputPath("pdf-selection-with-comment-badge.png"),
    animations: "disabled",
  });
  const outline = page.getByTestId("pdf-comment-focus-box");
  const originalOutline = await outline.elementHandle();
  await selectPdfText(page, "Your abstract here.", "Your abstract");
  await expect(excerpt).toContainText("Your abstract");
  await expect(comment).toHaveCount(1);
  expect(
    await outline.evaluate(
      (element, original) => element === original,
      originalOutline,
    ),
  ).toBe(true);

  await clearSelection();
  await expect(excerpt).toHaveCount(0);
  await expect(comment).toHaveCount(0);

  await selectPdfText(page, "Your abstract here.");
  await comment
    .getByRole("button", { name: "Pin comment", exact: true })
    .click();
  await clearSelection();
  await expect(excerpt).toHaveCount(0);
  await expect(comment).toHaveAttribute("data-selection-pinned", "true");
  await selectPdfText(page, "Your abstract here.");
  await expect(excerpt).toHaveCount(1);
  await expect(comment).toHaveCount(1);
});

test("a saved PDF highlight with overlapping rectangles requires shared text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStandalonePdf(page);
  await addComment(page, "Saved PDF comment");
  await expect
    .poll(() =>
      page.evaluate(() => {
        for (const [key, value] of Object.entries(localStorage)) {
          if (!key.startsWith("catalex-harness-comments:")) continue;
          const snapshot = JSON.parse(value);
          const comment = snapshot["paper.pdf"]?.find(
            (item: { text: string }) => item.text === "Saved PDF comment",
          );
          if (!comment?.pdf?.regions?.length) continue;
          // Reproduce a highlight whose stored box reaches into later text.
          comment.pdf.text = "Your abstract";
          localStorage.setItem(key, JSON.stringify(snapshot));
          return true;
        }
        return false;
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      /* @vite-ignore */ "/src/renderer/stores/document-store.ts"
    );
    const { PROJECT_COMMENTS_REFRESH_EVENT } = await import(
      /* @vite-ignore */ "/src/renderer/lib/workspace-events.ts"
    );
    window.dispatchEvent(
      new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
        detail: { projectRoot: useDocumentStore.getState().projectRoot },
      }),
    );
  });
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  const excerpt = drawer.locator('[data-selection-chip="true"]');
  const comment = drawer.locator('[data-comment-chip="true"]');
  await selectPdfText(page, "Your abstract here.", "abstract");
  await expect(comment).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useAgentChatStore } = await import(
          /* @vite-ignore */ "/src/renderer/stores/agent-chat-store.ts"
        );
        const state = useAgentChatStore.getState();
        return state.tabs
          .find((tab) => tab.id === state.activeTabId)
          ?.draft.pinnedContexts.find((context) => context.comment)
          ?.selectedText;
      }),
    )
    .toBe("Your abstract");
  await selectPdfText(page, "Your abstract here.", "here.");
  await expect(excerpt).toHaveCount(1);
  await expect(comment).toHaveCount(0);
});

test("standalone PDF comments share saved geometry and edits across main and pop-out views", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStandalonePdf(page);
  await addComment(page, "Clarify this PDF passage");
  await page.screenshot({
    path: test.info().outputPath("pdf-file-comment-main.png"),
    animations: "disabled",
  });
  const opened = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "More Editor view actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Pop out Editor", exact: true })
    .click();
  const child = await opened;
  await expect(child.locator(".mupdf-text-layer").first()).toBeVisible();
  const childCard = await addComment(child, "Added from the PDF pop-out");
  await child.screenshot({
    path: test.info().outputPath("pdf-file-comment-popout.png"),
    animations: "disabled",
  });
  await childCard
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  await childCard
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Updated in pop-out");
  await childCard
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.stringify(
          Object.entries(localStorage).filter(([key]) =>
            key.startsWith("catalex-harness-comments:"),
          ),
        ),
      ),
    )
    .toContain("Updated in pop-out");
  await childCard
    .getByRole("button", { name: "Resolve comment", exact: true })
    .click();
  await childCard
    .getByRole("button", { name: "Confirm resolve comment", exact: true })
    .click();
  await expect(
    childCard.getByText("Updated in pop-out", { exact: true }),
  ).toHaveCount(0);
  await child.getByTestId("pdf-scroll-container").focus();
  await child.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const all = Object.entries(localStorage).filter(([key]) =>
          key.startsWith("catalex-harness-comments:"),
        );
        return all.some(([, value]) => {
          try {
            return Object.values(JSON.parse(value))
              .flat()
              .some(
                (comment: any) =>
                  comment.text === "Updated in pop-out" && !comment.resolved,
              );
          } catch {
            return false;
          }
        });
      }),
    )
    .toBe(true);
  await child.close();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Fit height", exact: true }).click();
  await page.getByRole("button", { name: "Fit width", exact: true }).click();
  await expect(page.getByTestId("pdf-comment-layer").first()).toBeVisible();
  for (const mode of [
    "Fit height",
    "Fit width",
    "manual",
    "expanded",
    "restored",
  ]) {
    if (mode === "manual") {
      const zoom = page.getByRole("textbox", { name: "Zoom percentage" });
      await zoom.fill("125%");
      await zoom.press("Enter");
    } else if (mode === "expanded") {
      await page
        .getByRole("button", { name: "More Editor view actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Expand Editor", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Editor expanded" }),
      ).not.toHaveAttribute("data-panel-expansion-motion");
    } else if (mode === "restored") {
      await page
        .getByRole("button", { name: "Restore Editor", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Editor expanded" }),
      ).toHaveCount(0);
    } else {
      await page.getByRole("button", { name: mode, exact: true }).click();
    }
    await page.getByRole("button", { name: /Go to comment/ }).click();
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const text = [
            ...document.querySelectorAll(".mupdf-text-layer text"),
          ].find((el) => el.textContent?.startsWith("Your abstract here."));
          const highlight = document.querySelector(
            "[data-pdf-comment-highlight]",
          );
          if (!text || !highlight) return 1000;
          const a = text.getBoundingClientRect(),
            b = highlight.getBoundingClientRect();
          return Math.max(
            Math.abs(a.left - b.left),
            Math.abs(a.right - b.right),
            Math.abs(a.top - b.top),
            Math.abs(a.bottom - b.bottom),
          );
        });
      })
      .toBeLessThan(2);
  }
  await page.screenshot({
    path: test.info().outputPath("pdf-file-comments-scaled.png"),
    animations: "disabled",
  });
});

test("standalone PDF search reveals the matching comment card with its info bar folded", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStandalonePdf(page);
  const card = await addComment(page, "Review this standalone PDF passage");
  const scroller = page.getByTestId("pdf-scroll-container");
  await scroller.click({ position: { x: 10, y: 10 } });
  await expect(card).toBeHidden();
  const find = page.getByRole("button", { name: "Find", exact: true });
  await find.click();
  const search = page.getByTestId("preview-search-panel");
  const input = search.getByRole("textbox", { name: "Search", exact: true });
  await input.fill("standalone PDF passage");
  await expect(search.getByRole("status")).toHaveText("0/1");
  await input.press("Enter");
  await expect(card).toContainText("Review this standalone PDF passage");
  await expect(input).toBeFocused();
  await expect(page.locator("[data-comments-panel]:visible")).toHaveCount(0);
  await search.getByRole("button", { name: "Close", exact: true }).click();
  await expect(find).toBeVisible();
});
