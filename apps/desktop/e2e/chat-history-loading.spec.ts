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
    const { useAgentChatStore } = await import(
      resource?.name ?? "/src/renderer/stores/agent-chat-store.ts"
    );
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

test("Find jumps from saved history to the live reply using one bounded window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  await expect(page.locator(".cm-content")).toBeVisible();
  await page.evaluate(async () => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    const { useAgentChatStore: store } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const state = store.getState();
    const tab = state.tabs.find(
      (item: { id: string }) => item.id === state.activeTabId,
    );
    const history = Array.from({ length: 1601 }, (_, index) => ({
      uuid: `saved-${index}`,
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text:
              index === 350
                ? "The **quartz** saved match."
                : index === 1600
                  ? "Stale quartz quartz reply."
                  : `Saved message ${index}.`,
          },
        ],
      },
    }));
    await invoke("desktop:chat:checkpoint-save", {
      projectRoot: state.chatProjectRoot,
      snapshot: { version: 1, tabs: [{ ...tab, messages: history }] },
    });
    const live = [
      {
        ...history[1600],
        message: { content: [{ type: "text", text: "Live quartz reply." }] },
      },
    ];
    store.setState({
      tabs: [
        {
          ...tab,
          messages: live,
          isStreaming: true,
          history: { start: 1600, total: 1601, writable: true },
        },
      ],
      messages: live,
      isStreaming: true,
    });
    const harness = (window as any).__TAURI_INTERNALS__;
    const original = harness.invoke;
    (window as any).historyReads = [];
    harness.invoke = (
      command: string,
      args: { start: number; limit: number },
    ) => {
      if (command === "desktop:chat:messages")
        (window as any).historyReads.push({
          start: args.start,
          limit: args.limit,
        });
      return original(command, args);
    };
  });
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const chat = page.locator("[data-workspace-chat-pane]");
  await expect(chat.getByText("Live quartz reply.")).toBeVisible();
  await chat.getByRole("button", { name: "Find", exact: true }).click();
  const search = chat.getByTestId("chat-search-panel");
  const input = search.getByRole("textbox", { name: "Search", exact: true });
  const count = search
    .getByRole("group", { name: "Search navigation" })
    .getByRole("status");
  await input.fill("quartz");
  await expect(count).toHaveText("1/2");
  await expect(chat.getByText("The quartz saved match.")).toBeInViewport();
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...(CSS.highlights.get("catalex-chat-search-active") ?? [])]
          .map(String)
          .join(""),
      ),
    )
    .toBe("quartz");
  await page.screenshot({
    path: test.info().outputPath("saved-chat-find.png"),
  });
  await input.press("Enter");
  await expect(count).toHaveText("2/2");
  await expect(chat.getByText("Live quartz reply.")).toBeInViewport();
  expect(await page.evaluate(() => (window as any).historyReads)).toEqual([
    { start: 50, limit: 600 },
  ]);
});
