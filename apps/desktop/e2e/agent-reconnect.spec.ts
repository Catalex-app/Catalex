import { expect, test } from "@playwright/test";

for (const provider of ["claude", "codex"] as const) {
  test(`Reconnect leaves interrupted ${provider} work paused until explicit Continue`, async ({
    page,
  }) => {
    await page.goto(`/?debug=agent-pause&provider=${provider}`);
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await page.evaluate(async (provider) => {
      const host = window as any;
      const store = host.__agentPauseChatStore;
      const tabId = store.getState().activeTabId;
      host.reconnectCalls = [];
      const original = host.__TAURI_INTERNALS__.invoke;
      host.__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
        host.reconnectCalls.push(command);
        return original(command, args);
      };
      store.getState()._setError(tabId, "Connection lost during this turn");
      await original("plugin:event|emit", {
        event: `${provider}-complete`,
        payload: { tab_id: tabId, success: false },
      });
    }, provider);
    const error = page.locator("[data-chat-error-composer]");
    await expect(error).toContainText("Connection lost during this turn");
    await error.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(error).toHaveCount(0);
    await expect(page.getByTestId("pause-status")).toHaveText("paused");
    const resume = page.getByRole("button", { name: "Continue", exact: true });
    await expect(resume).toBeEnabled();
    expect(
      await page.evaluate(() =>
        (window as any).reconnectCalls.filter((command: string) =>
          /^(execute|resume)_(claude|codex)_code$/.test(command),
        ),
      ),
    ).toEqual([]);
    const state = await page.evaluate(() => {
      const store = (window as any).__agentPauseChatStore.getState();
      const tab = store.tabs.find((tab: any) => tab.id === store.activeTabId);
      return { workspace: tab.agentWorkspace, count: tab.messages.length };
    });
    expect(state.workspace.status).toBe("active");
    expect(state.count).toBe(2);
    await page.screenshot({
      path: test.info().outputPath(`${provider}-reconnected-paused.png`),
    });
    await resume.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).reconnectCalls.filter((command: string) =>
              /^(execute|resume)_(claude|codex)_code$/.test(command),
            ).length,
        ),
      )
      .toBe(1);
  });
}
