import { test, expect } from "@playwright/test";
test("forks a long saved chat without transferring its complete history", async ({
  page,
}) => {
  await page.goto("/?debug=agent-file-review");
  const toggle = page.getByRole("button", {
    name: "Toggle drawer",
    exact: true,
  });
  await toggle.waitFor();
  await page.evaluate(async () => {
    const resource = performance
      .getEntriesByType("resource")
      .find(
        (item) =>
          new URL(item.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!;
    const { useAgentChatStore: store } = await import(resource.name);
    const { saveProjectChats } = await import(
      "/src/renderer/lib/project-chat-lifecycle.ts"
    );
    const tab = {
      ...store.getState().tabs[0],
      agentWorkspace: null,
      isStreaming: false,
      title: "Long source",
    };
    const messages = Array.from({ length: 10000 }, (_, index) => ({
      type: index % 2 ? "user" : "assistant",
      uuid: `long-${index}`,
      message: { content: [{ type: "text", text: `Saved message ${index}` }] },
    }));
    store.setState({
      tabs: [{ ...tab, messages }],
      activeTabId: tab.id,
      messages,
      isStreaming: false,
    });
    await saveProjectChats();
    store.setState({
      tabs: [
        {
          ...tab,
          messages: messages.slice(9800),
          history: { start: 9800, total: 10000 },
        },
      ],
      messages: messages.slice(9800),
    });
    (window as any).forkStore = store;
    (window as any).forkCommands = [];
    const bridge = (window as any).__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    bridge.invoke = async (command: string, args: any) => {
      (window as any).forkCommands.push({ command, args });
      return invoke(command, args);
    };
  });
  if (!(await page.locator("[data-chat-messages]").isVisible()))
    await toggle.click();
  const drawer = page.locator("[data-chat-drawer-panel]");
  await expect(
    drawer.getByText("Saved message 9998", { exact: true }),
  ).toBeVisible();
  await drawer
    .getByRole("button", { name: "Fork from this response" })
    .last()
    .click();
  await expect(
    drawer.getByText("Saved message 9998", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).forkStore
            .getState()
            .tabs.find(
              (tab: any) =>
                tab.id === (window as any).forkStore.getState().activeTabId,
            )?.title,
      ),
    )
    .toBe("Long source (fork)");
  const result = await page.evaluate(() => ({
    messages: (window as any).forkStore.getState().messages.length,
    commands: (window as any).forkCommands,
    tab: (window as any).forkStore
      .getState()
      .tabs.find(
        (tab: any) =>
          tab.id === (window as any).forkStore.getState().activeTabId,
      ),
  }));
  expect(result.messages).toBeLessThanOrEqual(200);
  expect(result.tab.history.total).toBe(9999);
  expect(result.tab.providerSessionIds).toEqual({});
  expect(
    result.commands.some((call: any) => call.command === "desktop:chat:fork"),
  ).toBe(true);
  expect(
    result.commands
      .filter((call: any) => call.command === "desktop:chat:messages")
      .every((call: any) => call.args.limit <= 200),
  ).toBe(true);
  await expect(
    drawer.getByText("Saved message 9999", { exact: true }),
  ).toHaveCount(0);
  await expect(
    drawer.getByText("Saved message 9998", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/chat-backend-fork.png" });
});
