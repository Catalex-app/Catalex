import { expect, type Locator, type Page, test } from "@playwright/test";

function viewMode(page: Page, name: string) {
  return page
    .getByRole("tablist", { name: "Workspace view mode" })
    .getByRole("tab", { name, exact: true });
}

test("PDF search scans all pages, navigates, validates queries and closes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await viewMode(page, "PDF").click();
  const text = page.locator('[data-page-number="1"] .mupdf-text-layer').first();
  await expect(text).toBeVisible();
  const comments = page.locator(
    "[data-preview-pane] [data-comments-panel]:visible",
  );
  const commentPrevious = comments.getByRole("button", {
    name: "Previous comment",
    exact: true,
  });
  const barMetrics = (element: Element) => {
    const style = getComputedStyle(element);
    return [style.minHeight, style.padding, style.columnGap, style.rowGap];
  };
  const commentBarMetrics = await comments.evaluate(barMetrics);
  const commentButtonBox = await commentPrevious.boundingBox();
  await text.click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Control+f");
  const panel = page.getByTestId("preview-search-panel");
  await expect(panel).toBeVisible();
  expect(
    await panel.locator(":scope > div").first().evaluate(barMetrics),
  ).toEqual(commentBarMetrics);
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
  expect((await previous.boundingBox())?.width).toBe(commentButtonBox?.width);
  expect((await previous.boundingBox())?.height).toBe(commentButtonBox?.height);
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
  await viewMode(page, "Editor").click();
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
  await expect(
    page
      .getByTestId("editor-search-panel")
      .getByRole("textbox", { name: "Search", exact: true }),
  ).toBeFocused();
  await expect(page.getByTestId("preview-search-panel")).toHaveCount(0);
  await viewMode(page, "Preview").click();
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

async function chooseScope(
  panel: Locator,
  label: "All" | "Comments only" | "Text only",
) {
  const option = panel.getByRole("button", { name: label, exact: true });
  if (await option.isVisible()) {
    await option.click();
    return;
  }
  await panel.getByRole("button", { name: /^Search scope:/ }).click();
  await panel
    .page()
    .getByRole("menuitemradio", { name: label, exact: true })
    .click();
}

for (const pdf of [false, true]) {
  test(`comment search reveals the ${pdf ? "PDF" : "Markdown"} card in preview-only view`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?debug=comment-workspace${pdf ? "&pdf" : ""}`);
    await viewMode(page, pdf ? "PDF" : "Preview").click();
    const pane = page.locator("[data-preview-pane]");
    const commentsBar = pane.locator("[data-comments-panel]");
    await expect(commentsBar).toBeVisible();
    if (pdf) {
      await expect(pane.locator(".mupdf-text-layer").first()).toBeVisible();
      await pane.getByTestId("pdf-scroll-container").focus();
    } else {
      await pane
        .locator("iframe")
        .contentFrame()
        .getByRole("heading", {
          name: "Learning with limited data",
          exact: true,
        })
        .click();
    }
    await page.keyboard.press("Control+f");
    const panel = pane.getByTestId("preview-search-panel");
    const input = panel.getByRole("textbox", { name: "Search", exact: true });
    const counter = panel
      .getByRole("group", { name: "Search navigation" })
      .getByRole("status");
    const card = pane.getByRole("dialog", {
      name: "PDF comment",
      exact: true,
    });
    const scopeControl = panel.getByRole("group", { name: "Search scope" });
    await expect(
      scopeControl.getByRole("button", { name: "All", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const field = panel
      .getByRole("group", { name: "Search options" })
      .locator("..");
    const dimensions = (element: Element) => [
      element.getBoundingClientRect().height,
      getComputedStyle(element).borderRadius,
    ];
    expect(await field.evaluate(dimensions)).toEqual(
      await scopeControl.evaluate(dimensions),
    );
    await expect(commentsBar).toBeHidden();
    const commentsButton = pane.getByRole("button", {
      name: /^Show comments:/,
    });
    await expect(commentsButton).toBeVisible();
    await input.fill(pdf ? "Describe" : "clarify");
    await expect(counter).toHaveText("0/1");
    await expect(card).toBeHidden();
    await chooseScope(panel, "Text only");
    await expect(counter).toHaveText("0/0");
    await chooseScope(panel, "Comments only");
    await expect(counter).toHaveText("0/1");
    await input.press("Enter");
    await expect(counter).toHaveText("1/1");
    await expect(card).toContainText(
      pdf ? "Describe the problem" : "Please clarify the baseline",
    );
    await expect(input).toBeFocused();
    await expect(commentsBar).toBeHidden();
    await page.screenshot({
      path: test.info().outputPath("comment-search.png"),
    });
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(card).toBeHidden();
    await expect(commentsBar).toBeHidden();
    await expect(commentsButton).toBeVisible();
    await page.keyboard.press("Control+f");
    await expect(panel).toBeVisible();
    await commentsButton.click();
    await expect(panel).toHaveCount(0);
    await expect(commentsBar).toBeVisible();
  });
}

test("All navigates text first and wraps through comments in both directions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  await viewMode(page, "Preview").click();
  const pane = page.locator("[data-preview-pane]");
  await pane
    .locator("iframe")
    .contentFrame()
    .getByRole("heading", {
      name: "Learning with limited data",
      exact: true,
    })
    .click();
  await page.keyboard.press("Control+f");
  const panel = pane.getByTestId("preview-search-panel");
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  const counter = panel
    .getByRole("group", { name: "Search navigation" })
    .getByRole("status");
  const card = pane.getByRole("dialog", { name: "PDF comment", exact: true });
  await input.fill("evaluation");
  await expect(counter).toHaveText("1/3");
  await input.press("Enter");
  await expect(counter).toHaveText("2/3");
  await expect(card).toBeHidden();
  await input.press("Enter");
  await expect(counter).toHaveText("3/3");
  await expect(card).toContainText("Explain the evaluation challenge");
  await input.press("Shift+Enter");
  await expect(counter).toHaveText("2/3");
  await expect(card).toBeHidden();
  await input.press("Enter");
  await expect(counter).toHaveText("3/3");
  await expect(card).toBeVisible();
  await input.press("Enter");
  await expect(counter).toHaveText("1/3");
  await expect(card).toBeHidden();
  await input.press("Shift+Enter");
  await expect(counter).toHaveText("3/3");
  await expect(card).toBeVisible();
  await input.press("Shift+Enter");
  await expect(counter).toHaveText("2/3");
  await expect(card).toBeHidden();
});
test("editor search scope ignores obsolete replies, folds the info bar and supports keyboard navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  await page.locator(".cm-content").click({ position: { x: 40, y: 20 } });
  await page.keyboard.press("Control+f");
  const panel = page.getByTestId("editor-search-panel");
  const commentsBar = page.locator("[data-comments-panel]:visible");
  await expect(commentsBar).toHaveCount(0);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(commentsBar).toHaveCount(0);
  await page.keyboard.press("Control+f");
  await expect(
    panel.getByRole("button", { name: "All", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const buttons = await panel
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label")),
    );
  expect(buttons.slice(0, 3)).toEqual(["All", "Comments only", "Text only"]);
  const scopes = panel
    .getByRole("group", { name: "Search scope" })
    .getByRole("button");
  expect(await scopes.allTextContents()).toEqual(["", "", ""]);
  expect(
    await scopes.evaluateAll(
      (buttons) =>
        new Set(buttons.map((button) => button.getBoundingClientRect().width))
          .size,
    ),
  ).toBe(1);
  expect(buttons.slice(buttons.indexOf("Find in Selection"))).toEqual([
    "Find in Selection",
    "Find Previous",
    "Find Next",
    "Close",
  ]);
  const commentsButton = page.getByRole("button", { name: /^Show comments:/ });
  await expect(commentsButton).toBeVisible();
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
  await expect(panel.getByRole("status")).toHaveText("0/0");
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
  await chooseScope(panel, "Text only");
  await expect(panel.getByRole("status")).toHaveText("0/0");
  await commentsButton.click();
  await expect(panel).toHaveCount(0);
  await expect(commentsBar).toHaveCount(1);
});

test("opening Search folds Problems into its existing header button", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&markers");
  await page
    .getByRole("button", { name: "Hide comments", exact: true })
    .click();
  const problemsBar = page.locator("[data-problems-panel]");
  const problemsButton = page.getByRole("button", { name: /^Show problems:/ });
  await expect(
    problemsBar.or(problemsButton).filter({ visible: true }).first(),
  ).toBeVisible();
  if (await problemsButton.isVisible()) await problemsButton.click();
  await expect(problemsBar).toBeVisible();

  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+f");
  const search = page.getByTestId("editor-search-panel");
  await expect(search).toBeVisible();
  await expect(problemsBar).toBeHidden();
  await expect(problemsButton).toBeVisible();
  await search.getByRole("button", { name: "Close", exact: true }).click();
  await expect(problemsBar).toBeHidden();
  await expect(problemsButton).toBeVisible();
  await page.keyboard.press("Control+f");
  await expect(search).toBeVisible();
  await problemsButton.click();
  await expect(search).toHaveCount(0);
  await expect(problemsBar).toBeVisible();
});

test("Find follows focus between full chat and editor and skips the drawer", async ({
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
  const chatSearch = page.getByTestId("chat-search-panel");
  const chatSearchInput = chatSearch.getByRole("textbox", {
    name: "Search",
    exact: true,
  });
  await expect(chatSearchInput).toBeFocused();
  await page.keyboard.press("Control+f");
  await page.keyboard.press("Control+h");
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  await page
    .getByRole("tablist", { name: "Chat workspace content" })
    .getByRole("tab", { name: "Editor", exact: true })
    .click();
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+f");
  const editorSearch = page.getByTestId("editor-search-panel");
  await expect(
    editorSearch.getByRole("textbox", { name: "Search", exact: true }),
  ).toBeFocused();
  await editorSearch
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await chat.focus();
  await page.keyboard.press("Control+f");
  await expect(chatSearchInput).toBeFocused();
  await page.getByRole("button", { name: "Half", exact: true }).click();
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  await page
    .locator('[data-chat-drawer-panel="true"] textarea:visible')
    .click();
  await page.keyboard.press("Meta+f");
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  await expect(chatSearch).toHaveCount(0);
  await page.locator(".cm-content").click({ position: { x: 40, y: 20 } });
  await page.keyboard.press("Meta+f");
  await expect(page.getByTestId("editor-search-panel")).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("editor-focus-search.png"),
  });
});

test("chat Find navigates virtualized matches and highlights rendered Markdown", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.evaluate(async () => {
    const resource = performance
      .getEntriesByType("resource")
      .find(
        (item) =>
          new URL(item.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      );
    const { useAgentChatStore: store } = await import(
      resource?.name ?? "/src/renderer/stores/agent-chat-store.ts"
    );
    const state = store.getState();
    const tab = state.tabs.find(
      (item: { id: string }) => item.id === state.activeTabId,
    );
    const messages = Array.from({ length: 120 }, (_, index) => ({
      uuid: `search-fixture-${index}`,
      type: index === 12 ? "assistant" : "user",
      message: {
        content: [
          {
            type: "text",
            text:
              index === 12
                ? "First **needle** in the conversation."
                : index === 106
                  ? "Second needle in the conversation."
                  : `Fixture message ${index}.`,
          },
        ],
      },
    }));
    store.setState({ tabs: [{ ...tab, messages }], messages });
  });
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const chat = page.locator("[data-workspace-chat-pane]");
  const first = chat.getByText("First needle in the conversation.");
  const second = chat.getByText("Second needle in the conversation.");
  await expect(first).toHaveCount(0);
  await chat.getByRole("button", { name: "Find", exact: true }).click();
  const search = chat.getByTestId("chat-search-panel");
  const input = search.getByRole("textbox", { name: "Search", exact: true });
  await expect(input).toBeFocused();
  await input.fill("needle in the conversation");
  await expect(search.getByRole("status")).toHaveText("1/2");
  await expect(first).toBeInViewport();
  const activeMatch = () =>
    page.evaluate(() =>
      Array.from(CSS.highlights.get("catalex-chat-search-active") ?? [])
        .map((range) => range.toString())
        .join(""),
    );
  await expect.poll(activeMatch).toBe("needle in the conversation");
  await page.screenshot({ path: test.info().outputPath("chat-find.png") });
  await input.press("Enter");
  await expect(search.getByRole("status")).toHaveText("2/2");
  await expect(second).toBeInViewport();
  await expect.poll(activeMatch).toBe("needle in the conversation");
  await input.press("Shift+Enter");
  await expect(first).toBeInViewport();
  await search.getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(activeMatch).toBe("");
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
    await expect(panel.getByRole("status")).toHaveText("0/1");
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
      .toContain(expected);
  }
  await chooseScope(panel, "Text only");
  await expect(panel).toContainText("0/0");
  await page.screenshot({
    path: test.info().outputPath("comment-id-search.png"),
  });
});

test("the split PDF routes Find to the editor and the preview owns Find when shown alone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  const pane = page.locator("[data-preview-pane]");
  const preview = page.getByTestId("pdf-scroll-container");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  const find = page.getByRole("button", { name: "Find", exact: true });
  await expect(find).toHaveCount(1);
  await expect(
    pane.getByRole("button", { name: "Find", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("split-find-button.png"),
  });

  const left = page.getByTestId("editor-search-panel");
  const right = page.getByTestId("preview-search-panel");
  const leftInput = left.getByRole("textbox", { name: "Search", exact: true });
  await find.click();
  await expect(leftInput).toBeFocused();
  await expect(find).toHaveCount(0);
  await leftInput.fill("evaluation");
  await chooseScope(left, "Text only");

  await preview.focus();
  await page.keyboard.press("Control+f");
  await expect(leftInput).toBeFocused();
  await expect(leftInput).toHaveValue("evaluation");
  await expect(right).toHaveCount(0);

  await viewMode(page, "PDF").click();
  const previewFind = pane.getByRole("button", { name: "Find", exact: true });
  await expect(previewFind).toBeVisible();
  await previewFind.click();
  const rightInput = right.getByRole("textbox", {
    name: "Search",
    exact: true,
  });
  await expect(rightInput).toBeFocused();
  await expect(left).toHaveCount(0);
  await rightInput.fill("limited");
  await expect(right).toContainText(/1\/\d+/);
  await rightInput.press("Escape");
  await expect(rightInput).toBeFocused();
  await right.getByRole("button", { name: "Close", exact: true }).click();
  await expect(preview).toBeFocused();
  await expect(previewFind).toBeVisible();

  await viewMode(page, "Split").click();
  await expect(previewFind).toHaveCount(0);
  await preview.focus();
  await page.keyboard.press("Control+f");
  await expect(leftInput).toBeFocused();
  await expect(leftInput).toHaveValue("evaluation");
  await expect(
    left.getByRole("button", { name: "Text only", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("Find moves into panel actions after the editor statistics", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  const toolbar = page.locator("[data-editor-statistics-overflow]");
  const find = toolbar.getByRole("button", { name: "Find", exact: true });
  const findSeparator = toolbar.locator("[data-panel-find-separator]");
  await expect(find).toBeVisible();
  await expect(findSeparator).toBeVisible();
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(toolbar).toHaveAttribute(
    "data-editor-statistics-overflow",
    "true",
  );
  await expect(find).toBeVisible();
  await page.setViewportSize({ width: 620, height: 900 });
  await expect(find).toHaveCount(0);
  await expect(findSeparator).toBeHidden();
  await toolbar
    .getByRole("button", { name: "More Editor view actions", exact: true })
    .click();
  const menu = page.getByRole("menu");
  await expect(menu.locator("[data-editor-statistics-menu]")).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("find-in-panel-actions.png"),
  });
  await menu.getByRole("menuitem", { name: "Find…", exact: true }).click();
  await expect(
    page
      .getByTestId("editor-search-panel")
      .getByRole("textbox", { name: "Search", exact: true }),
  ).toBeFocused();
});

test("Escape from the Markdown iframe restores the split and its Find owner", async ({
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
  await expect(panel).toHaveCount(0);
  await heading.click();
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("editor-search-panel")).toBeVisible();
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
    if (surface !== "editor")
      await viewMode(page, surface === "PDF" ? "PDF" : "Preview").click();
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
  test(`${markdown ? "Markdown" : "LaTeX"} search drives the locked split`, async ({
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
    if (markdown) {
      await expect(sourceInput).toBeFocused();
      await expect(page.getByTestId("preview-search-panel")).toHaveCount(0);
      await sourceInput.fill("Markdown Preview");
      await expect.poll(editorScroll).toBeLessThan(editorAtEnd - 100);
      await sourceInput.fill("Sync destination");
      await expect.poll(previewScroll).toBeGreaterThan(150);
    } else {
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
    }

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
