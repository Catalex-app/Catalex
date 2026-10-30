import { expect, test } from "@playwright/test";

test("a collapsed composer updates pinned comments in inactive chat tabs", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace");
  await expect(
    page.locator('.cm-inlineCommentCard[data-inline-comment-id="H-1"]').first(),
  ).toBeVisible();
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser module
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    // @ts-expect-error Vite browser module
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.setState({
      selectionRange: null,
      pdfSelectionContext: null,
      commentSelectionContext: null,
    });
    const state = useAgentChatStore.getState();
    const tab = state.tabs[0];
    useAgentChatStore.setState({
      chatProjectRoot: "/browser-demo/Comment Review",
      activeTabId: tab.id,
      tabs: [
        { ...tab, draft: { input: "", pinnedContexts: [] } },
        {
          ...tab,
          id: "background-comment",
          draft: {
            input: "",
            pinnedContexts: [
              {
                label: "H-1",
                filePath: "manuscript.md",
                selectedText: "",
                selectionPinned: true,
                comment: {
                  id: "H-1",
                  agent: false,
                  text: "Please clarify the baseline.",
                },
              },
            ],
          },
        },
      ],
    });
  });
  const pinnedCount = () =>
    page.evaluate(async () => {
      // @ts-expect-error Vite browser module
      const { useAgentChatStore } = await import(
        "/src/renderer/stores/agent-chat-store.ts"
      );
      return useAgentChatStore
        .getState()
        .tabs.find((tab: { id: string }) => tab.id === "background-comment")
        .draft.pinnedContexts.length;
    });
  await expect.poll(pinnedCount).toBe(1);
  await page.evaluate(async () => {
    const projectRoot = "/browser-demo/Comment Review";
    const before = JSON.parse(
      localStorage.getItem(`catalex-harness-comments:${projectRoot}`)!,
    )["manuscript.md"].find((c: { id: string }) => c.id === "H-1");
    // @ts-expect-error Vite browser module
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    await invoke("update_project_comment", {
      projectRoot,
      patch: {
        filePath: "manuscript.md",
        id: before.id,
        before,
        after: { ...before, resolved: true },
      },
    });
  });
  await expect.poll(pinnedCount).toBe(0);
});

// Uses the real editor and composer in the existing workspace harness.
test("live context follows deselection and pinned excerpts survive new selections", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((element) => element.remove());
  const chips = page.locator(
    '[data-chat-drawer-panel="true"] [data-selection-chip="true"]:visible',
  );
  const input = page.locator(
    '[data-chat-drawer-panel="true"] textarea:visible',
  );
  const select = async (text: string) => {
    expect(
      await page.evaluate(
        (text) => window.__selectInputTransferHarnessText?.(text),
        text,
      ),
    ).toBe(true);
  };
  await select("Hello harness");
  await expect(chips).toHaveCount(1);
  await input.fill("Compare these passages");
  await expect(chips).toHaveCount(1);
  await chips
    .getByRole("button", { name: "Pin selection", exact: true })
    .click();
  await expect(chips).toHaveAttribute("data-selection-pinned", "true");
  await select("document");
  await expect(chips).toHaveCount(2);
  await input.click();
  await expect(chips).toHaveCount(2);
  await page.screenshot({
    path: "test-results/selection-context-pinned-and-live.png",
    fullPage: true,
  });
  // Reactivating the editor preserves its range; an arrow explicitly collapses it.
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ArrowRight");
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveAttribute("data-selection-pinned", "true");
  await select("Hello harness");
  await expect(chips).toHaveCount(1);
  await select("document");
  await expect(chips).toHaveCount(2);
  await chips
    .getByRole("button", { name: "Pin selection", exact: true })
    .click();
  await expect(chips.locator('[aria-label="Pinned selection"]')).toHaveCount(2);
  await chips.first().getByRole("button", { name: "Remove context" }).click();
  await expect(chips).toHaveCount(1);
  await input.fill("Remaining excerpt");
  await expect(chips).toHaveCount(1);
  await chips.getByRole("button", { name: "Remove context" }).click();
  await expect(chips).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.__getInputTransferHarnessSelectionState?.().selectionRange,
    ),
  ).toBeNull();
});

test("un-pinned editor selection clears when explicitly deselected", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.evaluate(() =>
    window.__selectInputTransferHarnessText?.("Hello harness"),
  );
  const chips = page.locator(
    '[data-chat-drawer-panel="true"] [data-selection-chip="true"]:visible',
  );
  await expect(chips).toHaveCount(1);
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ArrowRight");
  await expect(chips).toHaveCount(0);
});
