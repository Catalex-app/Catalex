import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 1000 } });
const editorKey = "catalex-harness-comments:/tmp/comment-harness";
async function read(page: Page, key: string, file: string, id: string) {
  return page.evaluate(
    ({ key, file, id }) =>
      JSON.parse(localStorage.getItem(key) ?? "{}")[file]?.find(
        (c: { id: string }) => c.id === id,
      ),
    { key, file, id },
  );
}
test("editor handles resize once, cancel, undo, redo, and persist", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript((key) => {
    if (!localStorage.getItem(key))
      localStorage.setItem(
        key,
        JSON.stringify({
          "main.tex": [
            {
              id: "resize",
              number: 1,
              from: 2,
              to: 9,
              line: 1,
              text: "Resize this comment",
            },
          ],
        }),
      );
  }, editorKey);
  await page.goto("/?debug=editor-comments");
  await expect(page.locator(".cm-inlineCommentCard")).toContainText(
    "Resize this comment",
  );
  await expect(page.locator("[data-comment-range-handle]")).toHaveCount(0);
  await page.locator(".cm-inlineCommentMark").first().click();
  await expect(page.locator("[data-comment-range-handle]")).toHaveCount(0);
  await page.locator(".cm-inlineCommentCard").click();
  await page.locator(".cm-scroller").evaluate((element) => {
    element.scrollTop = 0;
  });
  const end = page.getByRole("button", { name: "Resize comment end" });
  await expect(end).toBeVisible();
  await expect(end).toHaveCSS("cursor", "ew-resize");
  await end.hover();
  const point = await page.evaluate(
    () => window.__editorCommentsHarness!.coordsForText!("Comment harnes")!.end,
  );
  const box = (await end.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 8 });
  expect((await read(page, editorKey, "main.tex", "resize")).to).toBe(9);
  await page.mouse.up();
  await expect
    .poll(async () => (await read(page, editorKey, "main.tex", "resize")).to)
    .toBe(16);
  await page.screenshot({ path: "test-results/comment-range-editor.png" });
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => (await read(page, editorKey, "main.tex", "resize")).to)
    .toBe(9);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect
    .poll(async () => (await read(page, editorKey, "main.tex", "resize")).to)
    .toBe(16);
  await page.locator(".cm-inlineCommentCard").click();
  await page.locator(".cm-scroller").evaluate((element) => {
    element.scrollTop = 0;
  });
  const start = page.getByRole("button", { name: "Resize comment start" });
  await start.hover();
  const left = (await start.boundingBox())!;
  await page.mouse.move(left.x + left.width / 2, left.y + left.height / 2);
  await page.mouse.down();
  await page.mouse.move(point.x - 20, point.y, { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect((await read(page, editorKey, "main.tex", "resize")).from).toBe(2);
  await page.reload();
  await expect(page.locator(".cm-inlineCommentCard")).toContainText(
    "Resize this comment",
  );
  expect((await read(page, editorKey, "main.tex", "resize")).to).toBe(16);
  expect(errors).toEqual([]);
});

test("PDF focused highlight has draggable endpoints and persists a resize", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?debug=pdf-comments");
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  const highlight = page.locator('[data-pdf-comment-id="human-pdf"]').first();
  await expect(highlight).toBeAttached();
  await highlight.evaluate((element) => (element as HTMLElement).click());
  const end = page.getByRole("button", { name: "Resize comment end" });
  await expect(end).toBeVisible();
  const key = "catalex-harness-comments:/tmp/catalex-pdf-comments-harness";
  const original = await read(page, key, "chapter.tex", "human-pdf");
  await page.evaluate(() => {
    const events: unknown[] = [];
    (window as any).__commentRangeEvents = events;
    for (const type of [
      "pointerdown",
      "pointerup",
      "pointercancel",
      "gotpointercapture",
      "lostpointercapture",
    ])
      document.addEventListener(
        type,
        (event) => {
          const target = event.target as HTMLElement;
          events.push({
            type,
            target: target?.getAttribute?.("aria-label") ?? target?.tagName,
            x: (event as PointerEvent).clientX,
            y: (event as PointerEvent).clientY,
            rect: target?.getBoundingClientRect?.().toJSON(),
            time: performance.now(),
          });
        },
        true,
      );
  });
  await end.hover();
  const box = (await end.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 40, box.y + box.height / 2, { steps: 8 });
  await page.screenshot({ path: "test-results/comment-range-pdf-drag.png" });
  await page.mouse.up();
  try {
    await expect
      .poll(async () => (await read(page, key, "chapter.tex", "human-pdf")).to)
      .toBeLessThan(original.to);
  } catch (error) {
    await test.info().attach("resize-pointer-events", {
      body: JSON.stringify(
        await page.evaluate(() => (window as any).__commentRangeEvents),
        null,
        2,
      ),
      contentType: "application/json",
    });
    throw error;
  }
  expect((await read(page, key, "chapter.tex", "human-pdf")).from).toBe(
    original.from,
  );
  await page.screenshot({ path: "test-results/comment-range-pdf.png" });
  const resized = await read(page, key, "chapter.tex", "human-pdf");
  await end.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => (await read(page, key, "chapter.tex", "human-pdf")).to)
    .toBe(original.to);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect
    .poll(async () => (await read(page, key, "chapter.tex", "human-pdf")).to)
    .toBe(resized.to);
  expect(errors).toEqual([]);
});

test("Markdown preview endpoints resize across formatted source and undo", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const key = "catalex-harness-comments:/tmp/markdown-preview-harness";
  await page.addInitScript(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          "README.md": [
            {
              id: "md-resize",
              from: 27,
              to: 51,
              line: 3,
              text: "Resize Markdown",
            },
          ],
        }),
      ),
    key,
  );
  await page.goto("/?debug=markdown-preview");
  const preview = page.frameLocator('iframe[title="README.md preview"]');
  await expect(preview.locator("strong")).toHaveText(
    "GitHub-flavored Markdown",
  );
  const editorHandles = page.locator(".cm-editor [data-comment-range-handle]");
  const previewHandles = page.locator(
    '[data-testid="pdf-comment-layer"] [data-comment-range-handle]',
  );
  await page.locator(".cm-inlineCommentCard").click();
  await expect(editorHandles).toHaveCount(2);
  await expect(previewHandles).toHaveCount(2);
  await page.screenshot({ path: "test-results/comment-focus-shared.png" });
  await page.locator(".cm-inlineCommentMark").first().click();
  await expect(editorHandles).toHaveCount(0);
  await expect(previewHandles).toHaveCount(0);
  await page.locator(".cm-inlineCommentCard").click();
  await expect(editorHandles).toHaveCount(2);
  await expect(previewHandles).toHaveCount(2);
  await preview.locator("h1").click();
  await expect(editorHandles).toHaveCount(0);
  await expect(previewHandles).toHaveCount(0);
  await preview.locator("strong").click();
  await expect(editorHandles).toHaveCount(2);
  await expect(previewHandles).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(editorHandles).toHaveCount(0);
  await expect(previewHandles).toHaveCount(0);
  await page.locator(".cm-inlineCommentCard").click();
  await page.getByText("Markdown preview harness", { exact: true }).click();
  await expect(editorHandles).toHaveCount(0);
  await expect(previewHandles).toHaveCount(0);
  await preview.locator("strong").click();
  const end = page.locator(
    '[data-testid="pdf-comment-layer"] [data-comment-range-handle="to"]',
  );
  await expect(end).toBeVisible();
  const box = (await end.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 35, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await read(page, key, "README.md", "md-resize")).to)
    .toBeLessThan(51);
  await page.screenshot({ path: "test-results/comment-range-markdown.png" });
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => (await read(page, key, "README.md", "md-resize")).to)
    .toBe(51);
  expect(errors).toEqual([]);
});

test("PDF resize crosses a page boundary without creating a new comment", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&multipage");
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  const highlight = page
    .locator('[data-pdf-comment-id="page-comment-0"]')
    .first();
  await expect(highlight).toBeAttached();
  await highlight.evaluate((element) => (element as HTMLElement).click());
  const handle = page.locator(
    '[data-pdf-comment-page="1"] [data-comment-range-handle="to"]',
  );
  await handle.hover();
  const key = "catalex-harness-comments:/tmp/catalex-pdf-comments-harness";
  const original = await read(page, key, "multipage.tex", "page-comment-0");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Scrolling while holding the endpoint should keep capture on the first page.
  const page2 = page.locator('.mupdf-page[data-page-number="2"]');
  await page2.evaluate((element) => element.scrollIntoView({ block: "start" }));
  const text = page2
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "This paragraph" })
    .first();
  await expect(text).toBeVisible();
  const target = (await text.boundingBox())!;
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(
      async () => (await read(page, key, "multipage.tex", "page-comment-0")).to,
    )
    .toBeGreaterThan(original.to);
  expect((await read(page, key, "multipage.tex", "page-comment-0")).from).toBe(
    original.from,
  );
  await page.screenshot({ path: "test-results/comment-range-cross-page.png" });
});

test("reset point can expand, cancel, and undo its reset label", async ({
  page,
}) => {
  await page.addInitScript(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({
          "main.tex": [
            {
              id: "point",
              from: 9,
              to: 9,
              line: 1,
              text: "Reset point",
              positionReset: true,
            },
          ],
        }),
      ),
    editorKey,
  );
  await page.goto("/?debug=editor-comments");
  const card = page.locator(".cm-inlineCommentCard");
  await expect(card).toContainText("Lost");
  await expect(card).toHaveCSS("opacity", "1");
  await expect(card.locator(".cm-inlineCommentContent")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(card.locator(".cm-inlineCommentHeader")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(card.locator(".cm-inlineCommentHeader")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(card).toHaveCSS("background-color", "rgb(234, 179, 8)");
  await expect(card.locator(".cm-inlineCommentText")).toHaveCSS(
    "opacity",
    "0.75",
  );
  const placementHint = card.locator(".cm-inlineCommentPlacementHint");
  await expect(placementHint).not.toBeVisible();
  const badge = card.locator(".cm-inlineCommentBadge");
  await expect(badge).toHaveText("H-1");
  await expect(badge).toHaveCSS("border-top-width", "1px");
  await expect(badge).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(card.locator(".cm-inlineCommentTimestamp")).toHaveText(
    "Just now",
  );
  const marker = page.getByRole("button", {
    name: "Expand point comment selection",
  });
  await expect(marker).toBeVisible();
  await expect(marker.locator("span")).toHaveCSS("width", "1px");
  await expect(marker.locator("span")).toHaveCSS("box-shadow", "none");
  const status = card.locator(".cm-inlineCommentPlacementStatus");
  await expect(card.getByRole("button", { name: "Place comment" })).toHaveCount(
    0,
  );
  await expect(status).toHaveText("Lost");
  await expect(status).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(status).toHaveCSS("border-top-style", "solid");
  await expect(status).toHaveCSS("width", "56px");
  await expect(status).toHaveCSS("pointer-events", "none");
  await expect(status).not.toHaveAttribute("tabindex");
  await expect(
    card.getByRole("button", { name: "Edit comment", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Resolve comment", exact: true }),
  ).toHaveCount(0);
  const initialHeight = await card.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await card.click();
  await expect(placementHint).toBeVisible();
  await expect(placementHint).toContainText(
    "Drag the marker to reattach to text.",
  );
  await expect(card.locator(".cm-inlineCommentTimestamp")).not.toBeVisible();
  expect(
    await card.evaluate((element) => element.getBoundingClientRect().height),
  ).toBe(initialHeight);
  const glow = placementHint.locator("[data-context-glow]");
  await expect(glow).toHaveCSS("animation-name", "context-badge-attention");
  const firstStart = await glow.evaluate(
    (element) => element.getAnimations()[0]?.startTime,
  );
  const statusBox = (await status.boundingBox())!;
  await page.mouse.click(
    statusBox.x + statusBox.width / 2,
    statusBox.y + statusBox.height / 2,
  );
  await expect
    .poll(() =>
      glow.evaluate((element) => element.getAnimations()[0]?.startTime),
    )
    .not.toBe(firstStart);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await card.click();
  await expect(glow).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator(".cm-scroller").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(marker).toBeVisible();
  await expect(marker.locator("span")).toHaveCSS("width", "2px");
  await expect(marker.locator("span")).not.toHaveCSS("box-shadow", "none");
  const focusedOutline = await marker
    .locator("span")
    .evaluate((element) => getComputedStyle(element).boxShadow);
  await expect(page.locator(".cm-inlineCommentSuperscript")).toHaveCount(0);
  const right = (await marker.boundingBox())!;
  await page.screenshot({ path: "test-results/comment-point-marker.png" });
  const target = await page.evaluate(
    () => window.__editorCommentsHarness!.coordsForText!("Comment harnes")!.end,
  );
  for (const cancel of [true, false]) {
    await page.mouse.move(
      right.x + right.width / 2,
      right.y + right.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
    if (cancel) {
      await expect(card).toContainText("Lost");
      expect((await read(page, editorKey, "main.tex", "point")).to).toBe(9);
    }
  }
  await expect
    .poll(async () => (await read(page, editorKey, "main.tex", "point")).to)
    .toBe(16);
  await expect(card).not.toContainText("Lost");
  await expect(card).toHaveCSS("opacity", "1");
  await expect(card.locator(".cm-inlineCommentContent")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(placementHint).not.toBeVisible();
  await expect(status).toHaveCount(0);
  await expect(card.locator(".cm-inlineCommentText")).toHaveCSS("opacity", "1");
  await expect(badge).toHaveCSS("border-top-width", "0px");
  await expect(
    card.getByRole("button", { name: "Edit comment", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Resolve comment", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resize comment end" }).locator("span"),
  ).toHaveCSS("box-shadow", focusedOutline);
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () => (await read(page, editorKey, "main.tex", "point")).to)
    .toBe(9);
  await expect(card).toContainText("Lost");
  await expect(card).toHaveCSS("opacity", "1");
  await expect(card.locator(".cm-inlineCommentContent")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(card.locator(".cm-inlineCommentHeader")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(card.locator(".cm-inlineCommentHeader")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(card).toHaveCSS("background-color", "rgb(234, 179, 8)");
  await expect(badge).toHaveText("H-1");
  await expect(badge).toHaveCSS("border-top-width", "1px");
  await expect(badge).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(marker).toBeVisible();
  // The marker also remains visible when the comment card is not focused.
  await page.locator(".cm-content").click({ position: { x: 180, y: 10 } });
  await expect(placementHint).not.toBeVisible();
  await expect(card.locator(".cm-inlineCommentTimestamp")).toBeVisible();
  await expect(marker).toBeVisible();
  await expect(marker.locator("span")).toHaveCSS("width", "1px");
  await expect(marker.locator("span")).toHaveCSS("box-shadow", "none");
  const leftTarget = await page.evaluate(
    () => window.__editorCommentsHarness!.coordsForText!("Comment")!.start,
  );
  const pointBox = (await marker.boundingBox())!;
  await page.mouse.move(
    pointBox.x + pointBox.width / 2,
    pointBox.y + pointBox.height / 2,
  );
  await page.mouse.down();
  await expect(marker.locator("span")).toHaveCSS("box-shadow", focusedOutline);
  // Cross the fixed point in one drag, first right then left.
  await page.mouse.move(target.x, target.y, { steps: 5 });
  await page.mouse.move(leftTarget.x, leftTarget.y, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await read(page, editorKey, "main.tex", "point")).from)
    .toBe(2);
  expect((await read(page, editorKey, "main.tex", "point")).to).toBe(9);
});

test("lost card outline covers its solid header and handles adapt to the theme", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("catalex-comment-demo-theme", "light"),
  );
  await page.goto("/?debug=comment-workspace&unplaced=1");
  const card = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="A-7"]',
  );
  await card.locator(".cm-inlineCommentAttach").click();
  await expect(card).toHaveClass(/cm-inlineCommentSelected/);
  const marker = page.locator(
    '[data-comment-range-handle="point"] > span[style*="width: 2px"]',
  );
  await expect(marker).toBeVisible();
  const lightOutline = await marker.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  expect(lightOutline).toContain(
    await marker.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  );
  for (const theme of ["light", "dark"]) {
    if (theme === "dark")
      await page
        .getByRole("button", { name: "Toggle theme", exact: true })
        .click();
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    await card.locator(".cm-inlineCommentAttach").click();
    const ring = await card.evaluate((element) => {
      const outline = getComputedStyle(element, "::after");
      const header = getComputedStyle(
        element.querySelector(".cm-inlineCommentHeader")!,
      );
      return {
        inset: outline.inset,
        radius: outline.borderRadius,
        shadow: outline.boxShadow,
        pointerEvents: outline.pointerEvents,
        aboveHeader: Number(outline.zIndex) > Number(header.zIndex),
      };
    });
    expect(ring.inset).toBe("0px");
    expect(ring.radius).toBe("12px");
    expect(ring.shadow).toContain("2px");
    expect(ring.aboveHeader).toBe(true);
    expect(ring.pointerEvents).toBe("none");
    await expect(card.locator(".cm-inlineCommentBadge")).toHaveCSS(
      "background-color",
      "rgb(255, 250, 255)",
    );
    await expect(card.locator(".cm-inlineCommentPlacementStatus")).toHaveCSS(
      "background-color",
      "rgb(255, 250, 255)",
    );
    await expect(card.locator(".cm-inlineCommentBadge")).toHaveCSS(
      "border-top-width",
      "1px",
    );
    // Only read text is muted; both authors retain their ordinary solid card.
    for (const id of ["A-7", "H-3"]) {
      const lost = page.locator(`[data-inline-comment-id="${id}"]`);
      await expect(lost.locator(".cm-inlineCommentText")).toHaveCSS(
        "opacity",
        "0.75",
      );
      const style = await lost.evaluate((element) => ({
        card: getComputedStyle(element).backgroundColor,
        body: getComputedStyle(
          element.querySelector(".cm-inlineCommentContent")!,
        ).backgroundColor,
        overlay: getComputedStyle(
          element.querySelector(".cm-inlineCommentContent")!,
          "::after",
        ).content,
        divider: getComputedStyle(
          element.querySelector(".cm-inlineCommentHeader")!,
        ).borderBottomColor,
        headerOpacity: getComputedStyle(
          element.querySelector(".cm-inlineCommentHeader")!,
        ).opacity,
      }));
      expect(style.body).toBe(style.card);
      expect(style.overlay).toBe("none");
      expect(style.divider).not.toBe("rgba(0, 0, 0, 0)");
      expect(style.headerOpacity).toBe("1");
    }
    await page.screenshot({
      path: `test-results/lost-card-outline-${theme}.png`,
    });
    await card.evaluate(async (element) => {
      element
        .querySelector<HTMLButtonElement>(
          '[data-inline-comment-action="delete"]',
        )!
        .click();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const swipe = element
        .getAnimations({ subtree: true })
        .find(
          (animation) =>
            animation instanceof CSSTransition &&
            animation.transitionProperty === "clip-path",
        );
      if (!swipe) throw new Error("Delete swipe transition did not start");
      swipe.pause();
      swipe.currentTime = 80;
      // Sample both layers at the same point, independent of frame scheduling.
      for (const animation of element.getAnimations({ subtree: true })) {
        if (
          animation instanceof CSSTransition &&
          animation.transitionProperty === "opacity"
        ) {
          animation.pause();
          animation.currentTime = 80;
        }
      }
    });
    await expect(card).toHaveCSS("background-color", "rgb(114, 82, 181)");
    await expect(card.locator(".cm-inlineCommentContent")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    const swipeState = await card.evaluate((element) => ({
      clip: getComputedStyle(element, "::before").clipPath,
      textOpacity: getComputedStyle(
        element.querySelector(".cm-inlineCommentText")!,
      ).opacity,
    }));
    expect(Number(swipeState.textOpacity)).toBeGreaterThan(0.75);
    expect(Number(swipeState.textOpacity)).toBeLessThan(1);
    expect(swipeState.clip).not.toBe("inset(0px)");
    expect(swipeState.clip).not.toContain("100%");
    await page.screenshot({
      path: `test-results/lost-card-delete-mid-swipe-${theme}.png`,
    });
    await card.evaluate((element) =>
      element
        .getAnimations({ subtree: true })
        .forEach((animation) => animation.play()),
    );
    await card
      .getByRole("button", { name: "Cancel delete", exact: true })
      .click();
    await expect(card).not.toHaveAttribute("data-confirm-returning");
    await expect(card.locator(".cm-inlineCommentText")).toHaveCSS(
      "opacity",
      "0.75",
    );
  }
  const darkOutline = await marker.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  expect(darkOutline).not.toBe(lightOutline);
  expect(darkOutline).toBe("rgb(255, 255, 255) 0px 0px 0px 1px");
  await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
  await card.locator(".cm-inlineCommentAttach").click();
  await expect(marker).toHaveCSS("box-shadow", lightOutline);
  // Drawing above the header must not intercept its real controls.
  await card
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await expect(
    card.getByRole("button", { name: "Confirm delete comment", exact: true }),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "Cancel delete", exact: true })
    .click();
  await expect(card.locator(".cm-inlineCommentPlacementStatus")).toHaveText(
    "Lost",
  );
  await page.locator(".cm-scroller").evaluate((element) => {
    element.scrollTop = 180;
  });
  await page
    .locator('[data-inline-comment-id="H-3"] .cm-inlineCommentAttach')
    .click();
  const humanOutline = await marker.evaluate(
    (element) => getComputedStyle(element).boxShadow,
  );
  expect(humanOutline).not.toBe(lightOutline);
  expect(humanOutline).toContain(
    await marker.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  );
});

test("lost card details fade on focus, confirmation and placement with reduced-motion support", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&unplaced=1");
  const card = page.locator('[data-inline-comment-id="A-7"]');
  const hint = card.locator(".cm-inlineCommentPlacementHint");
  const timestamp = card.locator(".cm-inlineCommentTimestamp");
  const origin = card.locator(".cm-inlineCommentOrigin");
  await expect(card).toBeVisible();
  await expect(timestamp).toBeVisible();
  await expect(origin).toBeVisible();
  await expect(hint).not.toBeVisible();
  const beforeHeight = await card.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  await card.evaluate(async (element) => {
    element
      .querySelector<HTMLButtonElement>(".cm-inlineCommentAttach")!
      .click();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const fades = element
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation instanceof CSSTransition &&
          animation.transitionProperty === "opacity",
      );
    if (fades.length < 2) throw new Error("Metadata crossfade did not start");
    for (const fade of fades) {
      fade.pause();
      fade.currentTime = 50;
    }
  });
  const hintOpacity = Number(
    await hint.evaluate((element) => getComputedStyle(element).opacity),
  );
  const timestampOpacity = Number(
    await timestamp.evaluate((element) => getComputedStyle(element).opacity),
  );
  expect(hintOpacity).toBeGreaterThan(0);
  expect(hintOpacity).toBeLessThan(1);
  expect(timestampOpacity).toBeGreaterThan(0);
  expect(timestampOpacity).toBeLessThan(1);
  expect(
    await card.evaluate((element) => element.getBoundingClientRect().height),
  ).toBe(beforeHeight);
  await page.screenshot({ path: "test-results/lost-metadata-crossfade.png" });
  await card.evaluate((element) =>
    element
      .getAnimations({ subtree: true })
      .forEach((animation) => animation.play()),
  );
  await expect(hint).toHaveCSS("opacity", "1");
  await expect(timestamp).not.toBeVisible();
  await expect(origin).not.toBeVisible();
  await expect(card.locator(".cm-inlineCommentBadge")).toHaveCSS(
    "background-color",
    "rgb(255, 250, 255)",
  );
  await expect(card.locator(".cm-inlineCommentPlacementStatus")).toHaveCSS(
    "background-color",
    "rgb(255, 250, 255)",
  );
  // Rapid blur/focus reverses CSS transitions without leaving old text visible.
  for (let index = 0; index < 3; index++) {
    await page.locator(".cm-content").focus();
    await card.locator(".cm-inlineCommentAttach").click();
  }
  await page.locator(".cm-content").focus();
  await expect(hint).not.toBeVisible();
  await expect(timestamp).toHaveCSS("opacity", "1");
  await expect(origin).toBeVisible();
  await expect(card.locator(".cm-inlineCommentBadge")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(card.locator(".cm-inlineCommentPlacementStatus")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await card.evaluate(async (element) => {
    element
      .querySelector<HTMLButtonElement>(
        '[data-inline-comment-action="delete"]',
      )!
      .click();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    for (const animation of element.getAnimations({ subtree: true })) {
      if (
        animation instanceof CSSTransition &&
        ["opacity", "clip-path"].includes(animation.transitionProperty)
      ) {
        animation.pause();
        animation.currentTime = 50;
      }
    }
  });
  const textOpacity = Number(
    await card
      .locator(".cm-inlineCommentText")
      .evaluate((element) => getComputedStyle(element).opacity),
  );
  expect(textOpacity).toBeGreaterThan(0.75);
  expect(textOpacity).toBeLessThan(1);
  await page.screenshot({ path: "test-results/lost-text-crossfade.png" });
  await card.evaluate((element) =>
    element
      .getAnimations({ subtree: true })
      .forEach((animation) => animation.play()),
  );
  await card
    .getByRole("button", { name: "Cancel delete", exact: true })
    .click();
  await expect(card).not.toHaveAttribute("data-confirm-returning");
  await expect(card.locator(".cm-inlineCommentText")).toHaveCSS(
    "opacity",
    "0.75",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await card.locator(".cm-inlineCommentAttach").click();
  await expect(hint).toHaveCSS("transition-duration", "0s");
  await expect(hint).toHaveCSS("opacity", "1");
  await expect(timestamp).not.toBeVisible();
  expect(
    await card
      .locator(".cm-inlineCommentText")
      .evaluate((element) => getComputedStyle(element).transitionDuration),
  ).toBe("0s");
  await card
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  expect(
    await card
      .locator(".cm-inlineCommentText")
      .evaluate((element) => getComputedStyle(element).opacity),
  ).toBe("1");
  await card
    .getByRole("button", { name: "Cancel delete", exact: true })
    .click();
  expect(
    await card
      .locator(".cm-inlineCommentText")
      .evaluate((element) => getComputedStyle(element).opacity),
  ).toBe("0.75");
});
