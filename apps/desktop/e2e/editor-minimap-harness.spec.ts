import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1180, height: 800 } });

test("navigates long-file changes, deletions and comments and tracks the viewport", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?debug=editor-minimap");
  const minimap = page.getByRole("complementary", { name: "Document minimap" });
  await expect(minimap).toBeVisible();
  await expect(minimap.locator('[data-minimap-marker="add"]')).toHaveCount(1);
  await expect(minimap.locator('[data-minimap-marker="modify"]')).toHaveCount(
    1,
  );
  await expect(minimap.locator('[data-minimap-marker="delete"]')).toHaveCount(
    2,
  );
  const viewport = minimap.locator("[data-minimap-viewport]");
  const initial = (await viewport.boundingBox())!;
  const modified = minimap.locator('[data-minimap-marker="modify"]');
  await modified.hover();
  await expect(
    page.locator('.editor-minimap-card[data-state="open"]'),
  ).toContainText("The revised result");
  await page.screenshot({ path: "test-results/editor-minimap-light.png" });
  const targetLine = Number(await modified.getAttribute("data-minimap-line"));
  await modified.click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__editorMinimapHarness?.state()?.first),
    )
    .toBeLessThan(targetLine);
  await expect
    .poll(() =>
      page.evaluate(() => window.__editorMinimapHarness?.state()?.last),
    )
    .toBeGreaterThan(targetLine);
  await expect
    .poll(async () => (await viewport.boundingBox())!.y)
    .toBeGreaterThan(initial.y + 50);
  const selection = await page.evaluate(
    () => window.__editorMinimapHarness?.state()?.selection,
  );
  // Navigation now moves the cursor too, keeping review headers in sync.
  expect(selection).toBeGreaterThan(0);

  await minimap.locator('[data-minimap-marker="delete"]').last().click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__editorMinimapHarness?.state()?.last),
    )
    .toBeGreaterThan(1200);
  const human = minimap.locator('[data-minimap-marker="human"]').first();
  await human.hover();

  await expect(
    page.locator('.editor-minimap-card[data-state="open"]'),
  ).toContainText("Please clarify");
  await expect(
    page.locator('.editor-minimap-card[data-state="open"]'),
  ).toContainText("Compare this result");
  await page
    .locator(".editor-minimap-card-item")
    .filter({ hasText: "Compare this result" })
    .click();
  await expect(
    page.locator(
      '.cm-inlineCommentCard[data-inline-comment-id="minimap-comment-1"]',
    ),
  ).toBeVisible();

  await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
  await minimap.locator('[data-minimap-marker="error"]').hover();
  await expect(
    page.locator('.editor-minimap-card[data-state="open"]'),
  ).toContainText("Undefined control sequence");
  await page.screenshot({ path: "test-results/editor-minimap-dark.png" });
  expect(errors).toEqual([]);
});

test("persists filters, supports keyboard and drag navigation and resets for another file", async ({
  page,
}) => {
  await page.goto("/?debug=editor-minimap&markdown=1");
  const minimap = page.locator("[data-editor-minimap]");
  await expect(minimap.locator('[data-minimap-marker="modify"]')).toHaveCount(
    1,
  );
  await page
    .getByRole("button", { name: "Minimap layers", exact: true })
    .click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(3);
  await page.screenshot({ path: "test-results/minimap-layer-groups.png" });
  await page
    .getByRole("menuitemcheckbox", { name: "Comments", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(minimap.locator('[data-minimap-lane="1"]')).toHaveCount(0);
  await page.reload();
  await expect(minimap.locator('[data-minimap-marker="modify"]')).toHaveCount(
    1,
  );
  await expect(minimap.locator('[data-minimap-lane="1"]')).toHaveCount(0);

  const added = minimap.locator('[data-minimap-marker="add"]');
  await added.focus();
  await page.keyboard.press("ArrowDown");
  await expect(minimap.locator('[data-minimap-marker="modify"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => window.__editorMinimapHarness?.state()?.first),
    )
    .toBeGreaterThan(400);
  await expect(minimap.locator(".editor-minimap-scrubber")).toHaveCSS(
    "pointer-events",
    "auto",
  );
  // Let the keyboard jump and CodeMirror's follow-up layout finish before a new gesture.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const track = (await minimap.locator("[data-minimap-track]").boundingBox())!;
  await expect
    .poll(() =>
      page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.classList.contains("editor-minimap-scrubber"),
        { x: track.x + track.width - 1, y: track.y + 10 },
      ),
    )
    .toBe(true);
  await page.mouse.move(track.x + track.width - 1, track.y + 10);
  await page.mouse.down();
  // Wait for CodeMirror to report the newly rendered viewport.
  await expect
    .poll(() =>
      page.evaluate(() => window.__editorMinimapHarness?.state()?.first),
    )
    .toBeLessThan(30);
  await page.mouse.move(
    track.x + track.width - 1,
    track.y + track.height * 0.8,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(() => window.__editorMinimapHarness?.state()?.first),
    )
    .toBeGreaterThan(800);

  await page
    .getByRole("button", { name: "Short document", exact: true })
    .click();
  await expect(minimap.locator("[data-minimap-marker]")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: /Navigate document, visible lines 1 to 2 of 2/,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Long document", exact: true })
    .click();
  await expect(minimap.locator('[data-minimap-marker="modify"]')).toHaveCount(
    1,
  );
  const oldLine = Number(
    await minimap
      .locator('[data-minimap-marker="modify"]')
      .getAttribute("data-minimap-line"),
  );
  await page.evaluate(() => window.__editorMinimapHarness?.insertAtStart());
  await expect(
    minimap.locator('[data-minimap-marker="modify"]'),
  ).toHaveAttribute("data-minimap-line", String(oldLine + 50));
  await page.setViewportSize({ width: 600, height: 500 });
  await expect(minimap).toBeVisible();
  await page.screenshot({ path: "test-results/editor-minimap-narrow.png" });
});

test("shows pending review regions and updates after accepting them", async ({
  page,
}) => {
  await page.goto("/?debug=editor-minimap");
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  const minimap = page.locator("[data-editor-minimap]");
  const deletion = minimap
    .getByRole("button", { name: /Pending deletion/ })
    .first();
  await expect(deletion).toBeVisible();
  await expect(deletion.locator(".editor-minimap-stroke")).toHaveAttribute(
    "data-review-versions",
    "current",
  );
  await expect(
    page.getByRole("button", { name: "Minimap layers", exact: true }),
  ).toBeDisabled();
  // A native disabled button can still receive pointerdown; the menu trigger must guard it too.
  const layerButton = await page
    .getByRole("button", { name: "Minimap layers", exact: true })
    .boundingBox();
  await page.mouse.click(
    layerButton!.x + layerButton!.width / 2,
    layerButton!.y + layerButton!.height / 2,
  );
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(
    minimap.locator(".editor-minimap-stroke:not([data-kind=review])"),
  ).toHaveCount(0);
  await expect(minimap.locator('[data-kind="review"]').first()).toHaveCSS(
    "background-image",
    /linear-gradient/,
  );
  await deletion.hover();
  await expect(page.locator(".editor-minimap-before")).toContainText(
    "Paragraph 850",
  );
  await deletion.click();
  await expect(
    page.locator(".cm-deletedLine").filter({ hasText: "Paragraph 850" }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/editor-minimap-review.png" });
  await page.getByRole("button", { name: "Accept All", exact: false }).click();
  await expect(minimap.getByRole("button", { name: /Pending/ })).toHaveCount(0);
  await expect(minimap.locator('[data-minimap-marker="delete"]')).toHaveCount(
    3,
  );
});

test("settings toggle persists and exchanges the minimap for the vertical scrollbar", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-settings&section=appearance");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const toggle = page.getByRole("switch", {
    name: "Show minimap",
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: "test-results/minimap-settings-toggle.png" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.goto("/?debug=editor-minimap");
  await expect(page.locator(".cm-scroller")).toBeVisible();
  await expect(page.locator("[data-editor-minimap]")).toHaveCount(0);
  const widthWithout = (await page.locator(".cm-scroller").boundingBox())!
    .width;
  await expect(page.locator(".editor-with-minimap")).toHaveCount(0);
  await page.goto("/?debug=markdown-settings&section=appearance");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await page.goto("/?debug=editor-minimap");
  await expect(page.locator("[data-editor-minimap]")).toBeVisible();
  const scroller = page.locator(".cm-scroller");
  expect(widthWithout - (await scroller.boundingBox())!.width).toBeCloseTo(
    36,
    0,
  );
  const bars = await scroller.evaluate((element) => ({
    width: getComputedStyle(element, "::-webkit-scrollbar").width,
    height: getComputedStyle(element, "::-webkit-scrollbar").height,
    standard: getComputedStyle(element).scrollbarWidth,
  }));
  expect(bars.width).toBe("0px");
  expect(parseFloat(bars.height)).toBeGreaterThan(0);
  expect(bars.standard).toBe("auto");
  await scroller.hover();
  await page.mouse.wheel(0, 500);
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/minimap-scrollbar-hidden.png" });
});

test("dragging preserves the grab offset and scrolls by pixels", async ({
  page,
}) => {
  await page.goto("/?debug=editor-minimap");
  const scroller = page.locator(".cm-scroller");
  await expect(page.locator("[data-editor-minimap]")).toBeVisible();
  await scroller.evaluate((el) => {
    el.scrollTop = 7000;
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.__editorMinimapHarness?.state()?.first),
    )
    .toBeGreaterThan(200);
  const thumb = page.locator("[data-minimap-viewport]");
  await expect
    .poll(async () => (await thumb.boundingBox())!.y)
    .toBeGreaterThan(200);
  // Finish the initial scroll measurement before sampling the drag geometry.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const track = (await page.locator("[data-minimap-track]").boundingBox())!;
  const handle = (await thumb.boundingBox())!;
  const before = await scroller.evaluate((el) => ({
    top: el.scrollTop,
    max: el.scrollHeight - el.clientHeight,
  }));
  const x = track.x + track.width - 1;
  const y = handle.y + handle.height * 0.75;
  await expect
    .poll(() =>
      page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.classList.contains("editor-minimap-scrubber"),
        { x, y },
      ),
    )
    .toBe(true);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect
    .poll(() =>
      page
        .locator(".editor-minimap-scrubber")
        .evaluate((el) => el.hasPointerCapture(1)),
    )
    .toBe(true);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeCloseTo(
    before.top,
    0,
  );
  await page.mouse.move(x, y + 2);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeCloseTo(
      before.top + (2 / (track.height - handle.height)) * before.max,
      0,
    );
  await page.mouse.move(x, track.y + track.height + 60);
  await expect
    .poll(() =>
      scroller.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeLessThan(2);
  await page.mouse.move(x, track.y - 60);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
  await page.mouse.up();
  await page.screenshot({ path: "test-results/minimap-continuous-drag.png" });
});

test("visible changes stay inside the pixel-based viewport indicator with wrapping and comment cards", async ({
  page,
}) => {
  await page.goto("/?debug=editor-minimap");
  for (const width of [1180, 500]) {
    await page.setViewportSize({ width, height: 800 });
    for (const kind of ["modify", "add"]) {
      const mark = page.locator(`[data-minimap-marker="${kind}"]`).first();
      await expect(mark).toBeVisible();
      await mark.click();
      await expect
        .poll(async () => {
          const target = await mark.boundingBox();
          const viewport = await page
            .locator("[data-minimap-viewport]")
            .boundingBox();
          if (!target || !viewport) return false;
          const center = target.y + target.height / 2;
          return (
            center >= viewport.y - 1 &&
            center <= viewport.y + viewport.height + 1
          );
        })
        .toBe(true);
    }
  }
  await page.screenshot({
    path: "test-results/minimap-coordinate-alignment.png",
  });
});

test("minimap groups synchronize closed comment and problem bars without opening them", async ({
  page,
}) => {
  await page.goto("/?debug=editor-minimap&mixed-markers=1");
  const comments = page.locator("[data-comments-panel]");
  const problems = page.locator("[data-problems-panel]");
  const map = page.locator("[data-editor-minimap]");
  await page.getByRole("button", { name: /^Show comments:/ }).click();
  await page.getByRole("button", { name: "Next comment", exact: true }).click();
  await expect(comments).toContainText("A-2");
  await page
    .getByRole("button", { name: "Hide comments", exact: true })
    .click();
  await expect(comments).not.toBeVisible();
  const mixed = map
    .locator(".editor-minimap-mark")
    .filter({ has: page.locator('[data-kind="human"]') })
    .filter({ has: page.locator('[data-kind="warning"]') })
    .first();
  await mixed.click();
  await expect(comments).toContainText("H-1");
  await expect(problems).toContainText(
    "Reference needs another compilation pass.",
  );
  await expect(comments).not.toBeVisible();
  await expect(problems).not.toBeVisible();
  await page.getByRole("button", { name: /^Show comments:/ }).click();
  await expect(
    comments.getByRole("button", { name: "Go to comment H-1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Hide comments", exact: true })
    .click();
  await page.getByRole("button", { name: /^Show problems:/ }).click();
  await expect(problems).toContainText(
    "Reference needs another compilation pass.",
  );
  await page.screenshot({ path: "test-results/minimap-synchronized-bars.png" });
});

test("minimap navigation updates the proposal header counter", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&pdf&ui-demo&proposal");
  const marks = page.locator('[data-minimap-marker="review"]');
  await expect(marks).toHaveCount(2);
  await marks.last().click();
  await expect(page.getByText("2/2", { exact: true })).toBeVisible();
  await marks.first().click();
  await expect(page.getByText("1/2", { exact: true })).toBeVisible();
});

test("clicking a hovered marker closes its popup without reopening it", async ({
  page,
}) => {
  await page.goto("/?debug=editor-minimap");
  const marker = page.locator('[data-minimap-marker="modify"]');
  const popup = page.locator('.editor-minimap-card[data-state="open"]');
  await marker.hover();
  await expect(popup).toBeVisible();
  await page.evaluate(() => {
    const card = document.querySelector(
      '.editor-minimap-card[data-state="open"]',
    )!;
    document.body.setAttribute("data-minimap-popup-reopened", "false");
    new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.oldValue === "closed")) {
        document.body.setAttribute("data-minimap-popup-reopened", "true");
      }
    }).observe(card, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["data-state"],
    });
  });
  await marker.click();
  // Cover both the hover delay and the exit animation, not just the click frame.
  await page.waitForTimeout(400);
  await expect(page.locator("body")).toHaveAttribute(
    "data-minimap-popup-reopened",
    "false",
  );
  await expect(popup).toHaveCount(0);
  await page.mouse.move(10, 10);
  await marker.hover();
  await expect(popup).toBeVisible();
  await page.mouse.move(10, 10);
  await expect(popup).toHaveCount(0);
  await marker.focus();
  await expect(popup).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(popup).toHaveCount(0);
});

test("comment card selection synchronizes the bar without changing its author filter", async ({
  page,
}) => {
  await page.goto("/?debug=editor-minimap&selectable-comments");
  await page.locator('[data-minimap-marker="human"]').first().click();
  await page.getByRole("button", { name: /^Show comments:/ }).click();
  const panel = page.locator("[data-comments-panel]");
  const human = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="minimap-comment-0"] .cm-inlineCommentAttach',
  );
  const agent = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="minimap-comment-1"] .cm-inlineCommentAttach',
  );
  await agent.click();
  await expect(
    panel.getByRole("button", { name: "Go to comment A-2", exact: true }),
  ).toBeVisible();
  await human.click();
  await expect(
    panel.getByRole("button", { name: "Go to comment H-1", exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "Agent comments", exact: true })
    .click();
  await human.click();
  await expect(
    panel.getByRole("button", { name: "Agent comments", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    panel.getByRole("button", { name: "Go to comment A-2", exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: "All comments", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Hide comments", exact: true })
    .click();
  await human.click();
  await expect(panel).not.toBeVisible();
  await page.getByRole("button", { name: /^Show comments:/ }).click();
  await expect(
    panel.getByRole("button", { name: "Go to comment H-1", exact: true }),
  ).toBeVisible();
});
