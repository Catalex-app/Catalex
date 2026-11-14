import { expect, type Page, test } from "@playwright/test";

async function openWorkspace(page: Page) {
  await page.goto("/?debug=markdown-workspace");
  await expect(page.getByTestId("markdown-preview")).toBeVisible();
  await page.getByRole("tab", { name: "Duet", exact: true }).click();
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore;
    store.getState().requestDrawerOpen();
  });
  await expect(
    page.locator(
      '[data-chat-drawer-panel="true"] [data-chat-composer-input]:visible',
    ),
  ).toBeVisible();
}

async function selectPreview(page: Page, selector: string) {
  const text = page
    .frameLocator('iframe[title="README.md preview"]')
    .locator(selector)
    .first();
  await expect(text).toBeVisible();
  await text.evaluate((element) => {
    const selection = element.ownerDocument.getSelection()!;
    const range = element.ownerDocument.createRange();
    const walker = element.ownerDocument.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
    );
    const nodes: Node[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    range.setStart(nodes[0], 0);
    range.setEnd(nodes.at(-1)!, nodes.at(-1)!.textContent!.length);
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

const chips = (page: Page) =>
  page.locator(
    '[data-chat-drawer-panel="true"] [data-selection-chip="true"]:visible',
  );

async function clearPreview(page: Page) {
  await page
    .frameLocator('iframe[title="README.md preview"]')
    .locator("body")
    .evaluate((element) =>
      element.ownerDocument.getSelection()?.removeAllRanges(),
    );
}

for (const theme of ["light", "dark"]) {
  test(`Markdown preview badge updates, pins, clears, and sends rendered text with its file (${theme})`, async ({
    page,
  }) => {
    await page.addInitScript(
      (theme) => localStorage.setItem("theme", theme),
      theme,
    );
    await openWorkspace(page);
    await selectPreview(page, "p");
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page)).toContainText("README.md");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const path = "/src/renderer/stores/document-store.ts";
          return (await import(path)).useDocumentStore.getState()
            .markdownSelectionContext?.selectedText;
        }),
      )
      .toBe("Live GitHub-flavored Markdown with a local link.");
    await selectPreview(page, "strong");
    await expect(chips(page)).toHaveCount(1);
    await expect(chips(page)).toContainText("README.md:3:8-3:32");
    await clearPreview(page);
    await expect(chips(page)).toHaveCount(0);
    await selectPreview(page, "strong");
    await chips(page)
      .getByRole("button", { name: "Pin selection", exact: true })
      .click();
    await clearPreview(page);
    await expect(chips(page)).toHaveAttribute("data-selection-pinned", "true");
    await selectPreview(page, "blockquote p");
    await expect(chips(page)).toHaveCount(2);
    await clearPreview(page);
    await expect(chips(page)).toHaveCount(1);
    await page.screenshot({
      path: `../../output/playwright/markdown-selection-${theme}.png`,
      animations: "disabled",
    });
    await selectPreview(page, "p");
    await expect(chips(page)).toHaveCount(2);
    await page.evaluate(async () => {
      const path = "/src/renderer/stores/agent-chat-store.ts";
      const store = (await import(path)).useAgentChatStore;
      store.setState({
        sendPrompt: (prompt: string, context: unknown) => {
          Object.assign(window, { markdownSentPrompt: { prompt, context } });
        },
      });
    });
    await page
      .locator(
        '[data-chat-drawer-panel="true"] [data-chat-composer-input]:visible',
      )
      .fill("Explain the selected passage");
    await page
      .locator(
        '[data-chat-drawer-panel="true"] [data-chat-composer-input]:visible',
      )
      .press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => Reflect.get(window, "markdownSentPrompt")),
      )
      .toMatchObject({
        prompt: "Explain the selected passage",
        context: [
          {
            filePath: "README.md",
            selectedText: "GitHub-flavored Markdown",
          },
          {
            filePath: "README.md",
            selectedText: "Live GitHub-flavored Markdown with a local link.",
          },
        ],
      });
  });
}

test("preview selection works without comments or source mapping and clears on file changes", async ({
  page,
}) => {
  await openWorkspace(page);
  await page.evaluate(async () => {
    const settingsPath = "/src/renderer/stores/settings-store.ts";
    (await import(settingsPath)).useSettingsStore.setState({
      displayComments: false,
    });
  });
  // Highlighted code has no exact source text spans; keep the real passage anyway.
  await selectPreview(page, "pre code");
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page)).toContainText("README.md");
  await chips(page)
    .getByRole("button", { name: "Remove context", exact: true })
    .click();
  await expect(chips(page)).toHaveCount(0);
  await selectPreview(page, "strong");
  await expect(chips(page)).toHaveCount(1);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/document-store.ts";
    (await import(path)).useDocumentStore.getState().setActiveFile("notes.md");
  });
  await expect(chips(page)).toHaveCount(0);
});

test("editor and preview selections replace each other without a stale badge", async ({
  page,
}) => {
  await openWorkspace(page);
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Shift+End");
  await expect(chips(page)).toHaveCount(1);
  await selectPreview(page, "strong");
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page)).toContainText("README.md:3:8-3:32");
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Shift+End");
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page)).toContainText("README.md:1:1-1:19");
  await page.keyboard.press("ArrowRight");
  await expect(chips(page)).toHaveCount(0);
});
