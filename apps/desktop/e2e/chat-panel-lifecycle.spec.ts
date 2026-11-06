import { expect, type Page, test } from "@playwright/test";

async function setup(page: Page) {
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page.evaluate(async () => {
    const { useAgentChatStore: store } = await import(
      /* @vite-ignore */ "/src/renderer/stores/agent-chat-store.ts"
    );
    const { useDocumentStore: doc } = await import(
      /* @vite-ignore */ "/src/renderer/stores/document-store.ts"
    );
    const { openPanelWindow } = await import(
      /* @vite-ignore */ "/src/renderer/lib/panel-windows.ts"
    );
    store.setState({ chatProjectRoot: doc.getState().projectRoot });
    Object.assign(window, {
      chatStore: store,
      openChatPanel: () => openPanelWindow("chat", "duet"),
    });
  });
}

async function openChat(page: Page, id: string) {
  const opened = page.waitForEvent("popup");
  await page.evaluate((id) => {
    (window as any).chatStore.getState().setActiveTab(id);
    (window as any).openChatPanel();
  }, id);
  const child = await opened;
  await expect(child.locator("[data-panel-window-title]")).toBeVisible();
  return child;
}

test("several chat pop-outs keep bounded histories and leave unopened histories unloaded", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const store = (window as any).chatStore;
    const harness = (window as any).__TAURI_INTERNALS__;
    const previous = harness.invoke;
    (window as any).messageLoads = [];
    harness.invoke = async (command: string, args: any) => {
      if (command === "desktop:chat:messages") {
        (window as any).messageLoads.push(args);
        return Array.from(
          { length: Math.min(args.limit, 10000 - args.start) },
          (_, index) => ({
            uuid: `${args.tabId}-${args.start + index}`,
            type: "user",
            message: {
              content: [
                {
                  type: "text",
                  text: `${args.tabId} message ${args.start + index}. ${"History text. ".repeat(12)}`,
                },
              ],
            },
          }),
        );
      }
      return previous(command, args);
    };
    const source = store.getState().tabs[0];
    store.setState({
      tabs: ["first", "second", "unopened"].map((id) => ({
        ...source,
        id,
        runtimeSessionKey: id,
        title: id,
        agentWorkspace: null,
        isStreaming: false,
        turnPhase: null,
        messages: [],
        history: { total: 10000, start: 10000 },
      })),
      activeTabId: "first",
      messages: [],
      isStreaming: false,
    });
  });
  const first = await openChat(page, "first");
  await expect(first.getByText(/first message 9999\./)).toBeVisible();
  const second = await openChat(page, "second");
  await expect(second.getByText(/second message 9999\./)).toBeVisible();
  const scroller = first.locator(
    "[data-chat-messages] [data-virtuoso-scroller]",
  );
  await scroller.hover();
  await first.mouse.wheel(0, -100000);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).chatStore.getState().tabs[0].history.start,
      ),
    )
    .toBeLessThan(9400);
  await expect(second.getByText(/second message 9999\./)).toBeVisible();
  const snapshot = await page.evaluate(() => ({
    lengths: (window as any).chatStore
      .getState()
      .tabs.map((tab: any) => tab.messages.length),
    loads: (window as any).messageLoads,
  }));
  expect(snapshot.lengths[0]).toBeLessThanOrEqual(600);
  expect(snapshot.lengths[1]).toBe(600);
  expect(snapshot.lengths[2]).toBe(0);
  expect(
    snapshot.loads.every(
      (load: any) => load.limit <= 600 && load.tabId !== "unopened",
    ),
  ).toBe(true);
  expect(await first.locator("[data-message-index]").count()).toBeLessThan(50);
  expect(await second.locator("[data-message-index]").count()).toBeLessThan(50);
  await first.screenshot({
    path: test.info().outputPath("bounded-history-popout.png"),
  });
  await first.close();
  await second.close();
});

test("archiving or removing a chat closes only its own pop-out and releases registrations", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const store = (window as any).chatStore;
    const source = store.getState().tabs[0];
    store.setState({
      tabs: ["first", "second", "remaining"].map((id) => ({
        ...source,
        id,
        runtimeSessionKey: id,
        title: id,
      })),
      activeTabId: "first",
    });
  });
  const first = await openChat(page, "first");
  const second = await openChat(page, "second");
  // Exercise the owner-state notifications also used after archive persistence.
  const archived = first.waitForEvent("close");
  await page.evaluate(() => {
    const store = (window as any).chatStore;
    store.setState((state: any) => ({
      tabs: state.tabs.map((tab: any) =>
        tab.id === "first" ? { ...tab, archived: true } : tab,
      ),
    }));
  });
  await archived;
  expect(second.isClosed()).toBe(false);
  await expect(second.locator("[data-panel-window-title]")).toHaveText(
    "second",
  );
  const removed = second.waitForEvent("close");
  await page.evaluate(() =>
    (window as any).chatStore.getState().closeTab("second"),
  );
  await removed;
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__catalexPanelSessions.size),
    )
    .toBe(0);
});

test("a blocked popup does not leave a stale registration and can be retried", async ({
  page,
}) => {
  await setup(page);
  const id = await page.evaluate(() => {
    const original = window.open;
    window.open = () => null;
    try {
      (window as any).openChatPanel();
    } finally {
      window.open = original;
    }
    return (window as any).chatStore.getState().activeTabId;
  });
  expect(
    await page.evaluate(() => (window as any).__catalexPanelSessions.size),
  ).toBe(0);
  await expect(
    page.getByText("Could not open the panel window.", { exact: true }),
  ).toBeVisible();
  const child = await openChat(page, id);
  await expect(child.locator("[data-chat-composer-input]")).toBeVisible();
  await child.close();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__catalexPanelSessions.size),
    )
    .toBe(0);
});
