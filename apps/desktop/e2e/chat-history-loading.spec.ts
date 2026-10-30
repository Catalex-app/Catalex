import { expect, test } from "@playwright/test";

test("large saved chats load bounded windows and virtualize their messages", async ({
  page,
}) => {
  await page.goto("/?debug=agent-file-review");
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .waitFor();
  await page.evaluate(async () => {
    const resource = performance
      .getEntriesByType("resource")
      .find(
        (item) =>
          new URL(item.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      );
    const { useAgentChatStore } = await import(resource!.name);
    (window as any).chatStore = useAgentChatStore;
    const harness = (window as any).__TAURI_INTERNALS__;
    const previous = harness.invoke;
    (window as any).messageLoads = [];
    harness.invoke = async (command: string, args: any) => {
      if (command === "desktop:chat:messages") {
        (window as any).messageLoads.push(args);
        return Array.from(
          { length: Math.min(args.limit, 10000 - args.start) },
          (_, index) => ({
            uuid: `message-${args.start + index}`,
            type: "user",
            message: {
              content: [
                {
                  type: "text",
                  text: `History message ${args.start + index}. ${"Variable length text. ".repeat((index % 5) + 1)}`,
                },
              ],
            },
          }),
        );
      }
      return previous(command, args);
    };
    const state = useAgentChatStore.getState();
    const tab = {
      ...state.tabs[0],
      id: "long-history",
      title: "Long history",
      agentWorkspace: null,
      isStreaming: false,
      messages: [],
      history: { total: 10000, start: 10000 },
    };
    useAgentChatStore.setState({
      chatProjectRoot: "/demo",
      tabs: [tab],
      activeTabId: tab.id,
      messages: [],
      isStreaming: false,
    });
  });
  const toggle = page.getByRole("button", {
    name: "Toggle drawer",
    exact: true,
  });
  if (!(await page.locator("[data-chat-messages]").isVisible()))
    await toggle.click();
  await expect(
    page
      .locator("[data-chat-drawer-panel]")
      .getByText(/History message 9999\./),
  ).toBeVisible();
  expect(
    await page.locator("[data-chat-drawer-panel] [data-message-index]").count(),
  ).toBeLessThan(50);
  const scroller = page.locator(
    "[data-chat-drawer-panel] [data-chat-messages] [data-virtuoso-scroller]",
  );
  await scroller.hover();
  await page.mouse.wheel(0, -100000);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).chatStore.getState().tabs[0].history.start,
      ),
    )
    .toBeLessThan(9400);
  expect(
    await page.evaluate(
      () => (window as any).chatStore.getState().messages.length,
    ),
  ).toBeLessThanOrEqual(600);
  expect(
    await page.locator("[data-chat-drawer-panel] [data-message-index]").count(),
  ).toBeLessThan(50);
  expect(
    await page.evaluate(() =>
      (window as any).messageLoads.every((args: any) => args.limit <= 600),
    ),
  ).toBe(true);
  await expect(
    page
      .locator("[data-chat-drawer-panel]")
      .getByText(/History message 9400\./),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/chat-history-loading.png" });
  await page.evaluate(() => (window as any).chatStore.getState().createTab());
  await page.evaluate(() =>
    (window as any).chatStore.getState().setActiveTab("long-history"),
  );
  await expect(
    page
      .locator("[data-chat-drawer-panel]")
      .getByText(/History message 9400\./),
  ).toBeVisible();
  await scroller.hover();
  await page.mouse.wheel(0, 100000);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).chatStore
            .getState()
            .tabs.find((tab: any) => tab.id === "long-history").history.start,
      ),
    )
    .toBe(9400);
  await page.mouse.wheel(0, 100000);
  await expect(
    page
      .locator("[data-chat-drawer-panel]")
      .getByText(/History message 9999\./),
  ).toBeVisible();
  // A slow request from the previous chat must not block the next chat.
  await page.evaluate(() => {
    const harness = (window as any).__TAURI_INTERNALS__;
    const previous = harness.invoke;
    harness.invoke = async (command: string, args: any) => {
      if (command === "desktop:chat:messages" && args.tabId === "slow") {
        (window as any).slowRequested = true;
        await new Promise((resolve) => {
          (window as any).releaseSlow = resolve;
        });
        throw new Error("Previous chat failed to load");
      }
      return previous(command, args);
    };
    const store = (window as any).chatStore;
    const source = store.getState().tabs[0];
    store.setState({
      tabs: ["slow", "next"].map((id) => ({
        ...source,
        id,
        messages: [],
        history: { total: 10000, start: 10000 },
      })),
      activeTabId: "slow",
      messages: [],
    });
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).slowRequested))
    .toBe(true);
  await page.evaluate(() =>
    (window as any).chatStore.getState().setActiveTab("next"),
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).chatStore.getState().messages.length),
    )
    .toBe(600);
  await page.evaluate(() => (window as any).releaseSlow());
  await expect(page.getByText(/Previous chat failed to load/)).toHaveCount(0);
});
