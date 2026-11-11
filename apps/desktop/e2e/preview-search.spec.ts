import { expect, test } from "@playwright/test";

test("PDF search scans all pages, navigates, validates queries and closes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  const text = page.locator('[data-page-number="1"] .mupdf-text-layer').first();
  await expect(text).toBeVisible();
  await text.click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Control+f");
  const panel = page.getByTestId("preview-search-panel");
  await expect(panel).toBeVisible();
  const barMetrics = (element: Element) => {
    const style = getComputedStyle(element);
    return [style.minHeight, style.padding, style.columnGap, style.rowGap];
  };
  expect(
    await panel.locator(":scope > div").first().evaluate(barMetrics),
  ).toEqual(
    await page
      .locator("[data-comments-panel]:visible")
      .first()
      .evaluate(barMetrics),
  );
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  const navigation = panel.getByRole("group", { name: "Search navigation" });
  const counter = navigation.getByRole("status");
  const previous = navigation.getByRole("button", { name: "Find Previous" });
  const next = navigation.getByRole("button", { name: "Find Next" });
  await expect(counter).toHaveText("0/0");
  await expect(counter).toHaveCSS("opacity", "0.5");
  await expect(previous).toBeDisabled();
  await expect(next).toBeDisabled();
  const commentPrevious = page.getByRole("button", {
    name: "Previous comment",
    exact: true,
  });
  expect((await previous.boundingBox())?.width).toBe(
    (await commentPrevious.boundingBox())?.width,
  );
  expect((await previous.boundingBox())?.height).toBe(
    (await commentPrevious.boundingBox())?.height,
  );
  await input.fill("evaluation");
  await expect(panel).toContainText(/1\/\d+/);
  await expect(counter).toHaveCSS("opacity", "1");
  await expect(previous).toBeEnabled();
  await expect(next).toBeEnabled();
  expect(
    await page.locator("[data-pdf-search-highlights]").count(),
  ).toBeGreaterThan(1);
  await input.press("Enter");
  await expect(panel).toContainText(/2\/\d+/);
  await input.press("Shift+Enter");
  await expect(panel).toContainText(/1\/\d+/);
  await panel.getByRole("button", { name: "Use Regex", exact: true }).click();
  await input.fill("[");
  await expect(panel).toContainText("Invalid regex");
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.screenshot({
    path: test.info().outputPath("pdf-search-narrow.png"),
  });
  await input.press("Escape");
  await expect(input).toBeFocused();
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator("[data-pdf-search-highlights]")).toHaveCount(0);
  await page.locator(".cm-content").click({ position: { x: 30, y: 20 } });
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("editor-search-panel")).toBeVisible();
  await expect(panel).toHaveCount(0);
});

test("Markdown iframe routes search to preview and highlights rendered text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  const frame = page.frameLocator('iframe[title$=" preview"]');
  await frame.locator("#write").click({ position: { x: 40, y: 30 } });
  await page.keyboard.press("Control+f");
  const panel = page.getByTestId("preview-search-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  await input.fill("the");
  await expect(panel).toContainText(/1\/\d+/);
  await expect
    .poll(() =>
      frame
        .locator("#write")
        .evaluate(
          (el) =>
            el.ownerDocument.defaultView!.CSS.highlights.get("catalex-search")
              ?.size,
        ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      frame.locator("#write").evaluate((el) =>
        Array.from(
          el.ownerDocument.defaultView!.CSS.highlights.get("catalex-search") ??
            [],
        )
          .map((range) => range.toString())
          .join("|"),
      ),
    )
    .toMatch(/the/i);
  await input.press("Enter");
  await expect(panel).toContainText(/2\/\d+/);
  await page.screenshot({
    path: test.info().outputPath("markdown-search.png"),
  });
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect
    .poll(() =>
      frame
        .locator("#write")
        .evaluate((el) => el.ownerDocument.defaultView!.CSS.highlights.size),
    )
    .toBe(0);
});

for (const pdf of [false, true]) {
  test(`comment search defaults on and reveals ${pdf ? "PDF" : "Markdown"} comments`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?debug=comment-workspace" + (pdf ? "&pdf" : ""));
    await page
      .getByRole("tablist", { name: "Workspace view mode" })
      .getByRole("tab", { name: pdf ? "PDF" : "Preview", exact: true })
      .click();
    if (pdf) {
      await page
        .locator('[data-page-number="1"] .mupdf-text-layer')
        .first()
        .click({ position: { x: 30, y: 30 } });
    } else {
      await page
        .frameLocator('iframe[title$=" preview"]')
        .getByRole("heading", {
          name: "Learning with limited data",
          exact: true,
        })
        .click();
    }
    await page.keyboard.press("Control+f");
    const panel = page.getByTestId("preview-search-panel");
    const toggle = panel.getByRole("button", {
      name: "Include Comments",
      exact: true,
    });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await panel
      .getByRole("textbox", { name: "Search", exact: true })
      .fill(pdf ? "Describe" : "clarify");
    const result = panel.getByRole("button", { name: /Open comment:/ }).first();
    await expect(result).toBeVisible();
    await expect(result.locator("mark")).toHaveText(
      pdf ? "Describe" : "clarify",
    );
    await toggle.click();
    await expect(result).toHaveCount(0);
    await expect(panel).toContainText("0/0");
    await toggle.click();
    await result.click();
    const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
    await expect(card).toContainText(
      pdf ? "Describe the problem" : "Please clarify the baseline",
    );
    await page.screenshot({
      path: test
        .info()
        .outputPath(
          pdf ? "pdf-comment-search.png" : "markdown-comment-search.png",
        ),
    });
  });
}

test("editor comment toggle placement ignores obsolete replies and supports keyboard navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  await page.locator(".cm-content").click({ position: { x: 40, y: 20 } });
  await page.keyboard.press("Control+f");
  const panel = page.getByTestId("editor-search-panel");
  const toggle = panel.getByRole("button", {
    name: "Include Comments",
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const buttons = await panel
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label")),
    );
  expect(buttons.slice(buttons.indexOf("Find in Selection"))).toEqual([
    "Find in Selection",
    "Include Comments",
    "Find Previous",
    "Find Next",
    "Close",
  ]);
  const field = panel
    .getByRole("group", { name: "Search options" })
    .locator("..");
  const surface = page.locator("[data-chat-composer-surface]:visible").first();
  const background = (element: Element) =>
    getComputedStyle(element).backgroundColor;
  const idle = await surface.evaluate(background);
  await expect.poll(() => field.evaluate(background)).not.toBe(idle);
  await page.locator(".cm-content").focus();
  await expect.poll(() => field.evaluate(background)).toBe(idle);
  await panel.screenshot({ path: test.info().outputPath("search-idle.png") });
  await page.evaluate(() => {
    const projectRoot = "/browser-demo/Comment Review";
    const key = `catalex-harness-comments:${projectRoot}`;
    const comments = JSON.parse(localStorage.getItem(key)!);
    comments["manuscript.md"][0].replies = [
      {
        id: "search-reply",
        text: "ReplySearchFixture",
        createdAt: new Date().toISOString(),
      },
    ];
    localStorage.setItem(key, JSON.stringify(comments));
    window.dispatchEvent(
      new CustomEvent("catalex:project-comments-refresh", {
        detail: { projectRoot },
      }),
    );
  });
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  await input.fill("ReplySearchFixture");
  await expect(
    panel.getByRole("button", { name: "Open reply: ReplySearchFixture" }),
  ).toHaveCount(0);
  await input.fill("clarify");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(CSS.highlights)
          .filter(([name]) => name.startsWith("comment-search-"))
          .flatMap(([, highlight]) =>
            Array.from(highlight).map((range) => range.toString()),
          )
          .join("|"),
      ),
    )
    .toMatch(/clarify/i);
  await toggle.click();
  await expect(
    panel.getByRole("group", { name: "Comment search results" }),
  ).toHaveCount(0);
});

test("chat shortcuts do not open hidden editor search across Duet workspace and Duet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const chat = page.locator(
    '[data-workspace-panel-screen="true"] textarea:visible',
  );
  await chat.click();
  await page.keyboard.press("Meta+f");
  await page.keyboard.press("Control+f");
  await page.keyboard.press("Control+h");
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Half", exact: true }).click();
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  await page
    .locator('[data-chat-drawer-panel="true"] textarea:visible')
    .click();
  await page.keyboard.press("Meta+f");
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  await page.locator(".cm-content").click({ position: { x: 40, y: 20 } });
  await page.keyboard.press("Meta+f");
  await expect(page.getByTestId("editor-search-panel")).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("editor-focus-search.png"),
  });
});

test("comment IDs match case-insensitively only when comments are included", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  await page.locator(".cm-content").click({ position: { x: 40, y: 20 } });
  await page.keyboard.press("Control+f");
  const panel = page.getByTestId("editor-search-panel");
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  await panel.getByRole("button", { name: "Match Case", exact: true }).click();
  for (const [id, expected] of [
    ["h-1", "H-1"],
    ["H1", "H-1"],
    ["h1", "H-1"],
    ["h 1", "H-1"],
    ["a-7", "A-7"],
    ["a7", "A-7"],
    ["A 7", "A-7"],
  ]) {
    await input.fill(id);
    const result = panel.getByRole("button", {
      name: new RegExp("Open comment: " + expected),
    });
    await expect(result).toBeVisible();
    await expect(result.locator("mark")).toHaveText(expected);
    await result.click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Array.from(CSS.highlights)
            .filter(([name]) => name.startsWith("comment-search-"))
            .flatMap(([, highlight]) =>
              Array.from(highlight).map((range) => range.toString()),
            )
            .join("|"),
        ),
      )
      .toContain(expected);
  }
  await panel
    .getByRole("button", { name: "Include Comments", exact: true })
    .click();
  await expect(
    panel.getByRole("group", { name: "Comment search results" }),
  ).toHaveCount(0);
  await expect(panel).toContainText("0/0");
  await page.screenshot({
    path: test.info().outputPath("comment-id-search.png"),
  });
});

test("split search bars keep separate queries and close independently", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  const editor = page.locator(".cm-content");
  const preview = page.getByTestId("pdf-scroll-container");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();

  await editor.focus();
  await page.keyboard.press("Control+f");
  const left = page.getByTestId("editor-search-panel");
  const leftInput = left.getByRole("textbox", { name: "Search", exact: true });
  await leftInput.fill("evaluation");
  const includeComments = left.getByRole("button", {
    name: "Include Comments",
  });
  await includeComments.click();

  await preview.focus();
  await page.keyboard.press("Control+f");
  const right = page.getByTestId("preview-search-panel");
  const rightInput = right.getByRole("textbox", {
    name: "Search",
    exact: true,
  });
  await rightInput.fill("limited");
  await expect(right).toContainText(/1\/\d+/);
  await expect(leftInput).toHaveValue("evaluation");
  await rightInput.press("Escape");
  await expect(rightInput).toBeFocused();
  await expect(rightInput).toHaveValue("limited");

  await right.getByRole("button", { name: "Close", exact: true }).click();
  await expect(right).toHaveCount(0);
  await expect(preview).toBeFocused();
  await expect(leftInput).toHaveValue("evaluation");

  await left.getByRole("button", { name: "Close", exact: true }).click();
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+f");
  await expect(leftInput).toBeFocused();
  await expect(leftInput).toHaveValue("evaluation");
  await expect(includeComments).toHaveAttribute("aria-pressed", "false");

  await preview.focus();
  await page.keyboard.press("Control+f");
  await expect(rightInput).toBeFocused();
  await expect(rightInput).toHaveValue("limited");
});

test("Escape from the Markdown iframe leaves search open and restores the expanded pane", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace");
  await page
    .getByRole("button", { name: "More Preview view actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Expand Preview", exact: true })
    .click();
  const expanded = page.getByRole("dialog", {
    name: "Preview expanded",
    exact: true,
  });
  await expect(expanded).toBeVisible();
  const heading = page
    .frameLocator('iframe[title$=" preview"]')
    .getByRole("heading", {
      name: "Learning with limited data",
      exact: true,
    });
  await heading.click();
  await page.keyboard.press("Control+f");
  const panel = page.getByTestId("preview-search-panel");
  await expect(panel).toBeVisible();
  await heading.click();
  await page.keyboard.press("Escape");
  await expect(expanded).toHaveCount(0);
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByTestId("markdown-preview").locator("iframe"),
  ).toBeFocused();
});

test("a context menu owns Escape before the search behind it", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&pdf");
  const editor = page.locator(".cm-content");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await editor.focus();
  await page.keyboard.press("Control+f");
  const search = page.getByTestId("editor-search-panel");
  await expect(search).toBeVisible();
  await editor.click({ button: "right", position: { x: 80, y: 170 } });
  const menu = page.getByRole("menu").first();
  await expect(menu).toBeVisible();
  await menu.dispatchEvent("keydown", {
    key: "Escape",
    isComposing: true,
    bubbles: true,
    cancelable: true,
  });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(search).toBeVisible();
  await editor.focus();
  await page.keyboard.press("Escape");
  await expect(search).toBeVisible();
  await search.getByRole("button", { name: "Close", exact: true }).click();
  await expect(search).toHaveCount(0);
  await expect(editor).toBeFocused();
});

for (const surface of ["editor", "PDF", "Markdown"] as const) {
  test(`repeated Find focuses and selects the existing ${surface} query`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      surface === "Markdown"
        ? "/?debug=comment-workspace"
        : "/?debug=comment-workspace&pdf",
    );
    if (surface !== "Markdown")
      await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
    const focusContent = async () => {
      if (surface === "editor") await page.locator(".cm-content").focus();
      else if (surface === "PDF")
        await page.locator("[data-preview-search-scope]").first().focus();
      else
        await page
          .frameLocator('iframe[title$=" preview"]')
          .locator("#write")
          .evaluate((node) => {
            node.tabIndex = -1;
            node.focus();
          });
    };
    await focusContent();
    await page.keyboard.press("Control+f");
    const panel = page.getByTestId(
      surface === "editor" ? "editor-search-panel" : "preview-search-panel",
    );
    const input = panel.getByRole("textbox", { name: "Search", exact: true });
    await input.fill("evaluation");
    const toggle = panel.getByRole("button", {
      name: "Match Case",
      exact: true,
    });
    await toggle.click();
    for (const shortcut of ["Control+f", "Meta+f"]) {
      await focusContent();
      await page.keyboard.press(shortcut);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("evaluation");
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(
        await input.evaluate((node: HTMLInputElement) => [
          node.selectionStart,
          node.selectionEnd,
        ]),
      ).toEqual([0, 10]);
    }
  });
}

test("reloading the same compiled PDF keeps the open query and options", async ({
  page,
}) => {
  await page.goto("/?debug=latex-scroll-sync");
  const scroller = page.getByTestId("pdf-scroll-container");
  const firstPage = scroller.locator('[data-page-number="1"]');
  await expect(firstPage.locator(".mupdf-text-layer")).toBeVisible();
  await scroller.focus();
  await page.keyboard.press("Control+f");
  const search = page.getByTestId("preview-search-panel");
  const input = search.getByRole("textbox", { name: "Search", exact: true });
  await input.fill("Chapter");
  const matchCase = search.getByRole("button", { name: "Match Case" });
  await matchCase.click();
  await input.focus();
  await expect(search).toContainText(/1\/\d+/);
  const previousPage = await firstPage.elementHandle();
  await page
    .getByTestId("simulate-latex-recompile")
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect
    .poll(() => previousPage?.evaluate((element) => element.isConnected))
    .toBe(false);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Chapter");
  await expect(matchCase).toHaveAttribute("aria-pressed", "true");
  await expect(search).toContainText(/1\/\d+/);
  await page.keyboard.press("Control+f");
  expect(
    await input.evaluate((element: HTMLInputElement) => [
      element.selectionStart,
      element.selectionEnd,
    ]),
  ).toEqual([0, 7]);
});

for (const markdown of [false, true]) {
  test(`${markdown ? "Markdown" : "LaTeX"} search drives the locked split from either pane`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 650 });
    await page.goto(
      markdown ? "/?debug=markdown-workspace" : "/?debug=latex-scroll-sync",
    );

    const editor = page.locator(".cm-content");
    const editorScroll = () =>
      page.locator(".cm-scroller").evaluate((el) => el.scrollTop);
    const frame = page.getByTestId("markdown-preview").locator("iframe");
    const pdf = page.getByTestId("pdf-scroll-container");
    const previewScroll = () =>
      markdown
        ? frame
            .contentFrame()
            .locator("html")
            .evaluate((el) => el.scrollTop)
        : pdf.evaluate((el) => el.scrollTop);
    const lock = page.getByRole("button", {
      name: "Disable synchronized scrolling",
    });
    await expect(lock).toHaveAttribute("aria-pressed", "true");
    if (markdown) {
      await expect(
        frame.contentFrame().getByRole("heading", { name: "Sync destination" }),
      ).toBeAttached();
    } else {
      await expect(page.locator(".mupdf-page")).toHaveCount(8);
    }

    await editor.focus();
    await page.keyboard.press("Control+f");
    const sourceInput = page
      .getByTestId("editor-search-panel")
      .getByRole("textbox", { name: "Search", exact: true });
    await sourceInput.fill(markdown ? "Sync destination" : "source line 350");
    await expect.poll(previewScroll).toBeGreaterThan(markdown ? 150 : 1_500);
    const editorAtEnd = await editorScroll();

    if (markdown) await frame.focus();
    else await pdf.focus();
    await page.keyboard.press("Control+f");
    const renderedInput = page
      .getByTestId("preview-search-panel")
      .getByRole("textbox", { name: "Search", exact: true });
    await renderedInput.fill(markdown ? "Markdown Preview" : "Book Title");
    await expect.poll(editorScroll).toBeLessThan(editorAtEnd - 100);
    await expect(renderedInput).toBeFocused();
    await expect(sourceInput).toHaveValue(
      markdown ? "Sync destination" : "source line 350",
    );

    await sourceInput.press("Enter");
    await expect.poll(previewScroll).toBeGreaterThan(markdown ? 150 : 1_500);
    await renderedInput.press("Enter");
    await expect.poll(editorScroll).toBeLessThan(editorAtEnd - 100);

    await lock.click();
    await expect(
      page.getByRole("button", { name: "Enable synchronized scrolling" }),
    ).toHaveAttribute("aria-pressed", "false");
    const beforeUnlockedSearch = await previewScroll();
    await sourceInput.fill(markdown ? "The fifth section" : "source line 320");
    await expect.poll(editorScroll).toBeGreaterThan(editorAtEnd / 2);
    expect(await previewScroll()).toBeCloseTo(beforeUnlockedSearch, 0);
  });
}
