import { expect, test, type Page } from "@playwright/test";

async function chatState(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const { useAgentChatStore } = await import(path);
    const { tabs, activeTabId } = useAgentChatStore.getState();
    return { tabs, activeTabId };
  });
}

test("New Chat reuses an untouched chat, focuses input, and preserves drafts", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  const input = drawer.locator("textarea:visible");
  const create = drawer.getByRole("button", { name: "New chat", exact: true });
  await expect(input).toBeVisible();
  const initial = await chatState(page);
  await expect(create).toHaveCount(0);
  await expect(drawer.getByText("Ready", { exact: true })).toHaveCount(0);
  await input.fill("Keep this draft");
  await expect(create).toHaveCount(0);
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((el) => el.remove());
  await page.screenshot({
    path: test.info().outputPath("collapsed-new-chat.png"),
    animations: "disabled",
  });
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const { useAgentChatStore } = await import(path);
    const state = useAgentChatStore.getState();
    const previous = {
      ...state.tabs[0],
      id: "previous",
      title: "Previous chat",
      sharedSessionId: "previous-session",
      draft: { input: "", pinnedContexts: [] },
    };
    useAgentChatStore.setState({ tabs: [...state.tabs, previous] });
    useAgentChatStore.getState().setActiveTab(previous.id);
  });
  await expect(create).toBeVisible();
  await create.hover();
  await expect(
    page.getByRole("tooltip", { name: "New chat", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("collapsed-plus-button.png"),
    animations: "disabled",
  });
  await create.click();
  await expect(input).toHaveValue("Keep this draft");
  await expect(input).toBeFocused();
  const created = await chatState(page);
  expect(created.tabs).toHaveLength(initial.tabs.length + 1);
  expect(
    created.tabs.find((t: { id: string }) => t.id === initial.activeTabId).draft
      .input,
  ).toBe("Keep this draft");
  await page
    .getByRole("button", { name: "Session history", exact: true })
    .click();
  await expect(
    page.getByText("No previous chats", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "New Chat", exact: true }),
  ).toHaveCount(0);
  expect((await chatState(page)).activeTabId).toBe(created.activeTabId);
  await page.screenshot({
    animations: "disabled",
    path: test.info().outputPath("empty-session-history.png"),
  });
});

test("queued attachments remain in the original draft with mounted composers", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await expect(
    page.locator('[data-chat-drawer-panel="true"] textarea:visible'),
  ).toBeVisible();
  const source = await chatState(page);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const { useAgentChatStore } = await import(path);
    const store = useAgentChatStore.getState();
    store.addPendingAttachment({
      label: "queued-file",
      filePath: "notes.txt",
      selectedText: "notes",
    });
    store.requestNewChat();
  });
  await expect
    .poll(
      async () =>
        (await chatState(page)).tabs.find(
          (tab: { id: string }) => tab.id === source.activeTabId,
        ).draft.pinnedContexts,
    )
    .toEqual([
      { label: "queued-file", filePath: "notes.txt", selectedText: "notes" },
    ]);
  const current = await chatState(page);
  expect(current.activeTabId).toBe(source.activeTabId);
  expect(
    current.tabs.find((tab: { id: string }) => tab.id === current.activeTabId)
      .draft.pinnedContexts,
  ).toEqual([
    { label: "queued-file", filePath: "notes.txt", selectedText: "notes" },
  ]);
});

test("the single draft stays fixed on the right and disappears only when left empty", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await expect(
    page.locator('[data-chat-drawer-panel="true"] textarea:visible'),
  ).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const { useAgentChatStore } = await import(path);
    const store = useAgentChatStore.getState();
    const draft = store.tabs.find(
      (tab: { id: string }) => tab.id === store.activeTabId,
    );
    const history = Array.from({ length: 18 }, (_, i) => ({
      ...draft,
      id: `history-${i}`,
      sharedSessionId: `session-${i}`,
      title: `Conversation ${i}`,
    }));
    useAgentChatStore.setState({
      tabs: [...history, draft],
      drawerOpenRequested: true,
    });
  });
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  const draftTab = drawer.locator('[data-new-chat-tab="true"]');
  const input = drawer.locator("textarea:visible");
  await expect(draftTab).toBeVisible();
  await expect(draftTab.getByRole("button", { name: /Archive/ })).toHaveCount(
    0,
  );
  await input.fill("Preserve this draft");
  const initialScroll = drawer.locator(".overflow-x-auto").first();
  await expect
    .poll(async () =>
      initialScroll.evaluate((element) =>
        Math.abs(
          element.scrollWidth - element.clientWidth - element.scrollLeft,
        ),
      ),
    )
    .toBeLessThan(2);
  const before = await draftTab.boundingBox();
  await drawer.getByText("Conversation 0", { exact: true }).click();
  await expect(draftTab).toBeVisible();
  const scroll = drawer.locator(".overflow-x-auto").first();
  await scroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect
    .poll(async () => (await draftTab.boundingBox())?.x)
    .toBe(before?.x);
  await scroll.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await expect
    .poll(async () => (await draftTab.boundingBox())?.x)
    .toBe(before?.x);
  await expect(
    drawer.getByRole("button", { name: "New tab", exact: true }),
  ).toBeDisabled();
  await draftTab.getByRole("button", { name: "New Chat", exact: true }).click();
  await expect(input).toHaveValue("Preserve this draft");
  await expect(draftTab).toHaveCount(1);
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((element) => element.remove());
  await page.screenshot({
    path: test.info().outputPath("fixed-new-chat.png"),
    animations: "disabled",
  });
  await input.fill("");
  await drawer.getByText("Conversation 0", { exact: true }).click();
  await expect(draftTab).toHaveCount(0);
  const plus = drawer.getByRole("button", { name: "New tab", exact: true });
  const plusX = (await plus.boundingBox())!.x;
  await scroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect.poll(async () => (await plus.boundingBox())!.x).toBe(plusX);
  await scroll.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await expect.poll(async () => (await plus.boundingBox())!.x).toBe(plusX);
  await drawer.getByText("Conversation 17", { exact: true }).click();
  await expect
    .poll(async () =>
      scroll.evaluate((element) =>
        Math.abs(
          element.scrollWidth - element.clientWidth - element.scrollLeft,
        ),
      ),
    )
    .toBeLessThan(2);
  await page.screenshot({
    path: test.info().outputPath("fixed-new-chat-plus.png"),
    animations: "disabled",
  });
  await drawer.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(draftTab).toHaveCount(1);
  await expect(input).toBeFocused();
});
