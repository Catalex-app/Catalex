// @ts-nocheck
import { test, expect } from "@playwright/test";

for (const paused of [false, true]) {
  test(`expanded ${paused ? "paused" : "idle"} tabs require archive confirmation`, async ({
    page,
  }) => {
    await page.goto("/?debug=agent-file-review");
    await page
      .getByRole("button", { name: "Toggle drawer", exact: true })
      .waitFor();
    await page.waitForTimeout(500);
    if (
      (await page.locator("[data-chat-drawer-panel] [data-tab-id]").count()) ===
      0
    ) {
      await page
        .getByRole("button", { name: "Toggle drawer", exact: true })
        .click();
      await page.waitForTimeout(400);
    }
    await page.evaluate(async (paused) => {
      const { useAgentChatStore: s } = await import(
        /* @vite-ignore */ "/src/renderer/stores/agent-chat-store.ts"
      );
      const state = s.getState();
      const original = state.tabs.find((t) => t.id === state.activeTabId);
      const idle = {
        ...original,
        id: "archive-fixture",
        title: "Completed experiment",
        agentWorkspace: paused ? original.agentWorkspace : null,
        isStreaming: false,
        isSettling: false,
        turnPhase: null,
        pauseState: paused ? "paused" : null,
      };
      window.archiveCalls = [];
      s.setState({
        tabs: [...state.tabs, idle],
        archiveTab: async (id) => {
          window.archiveCalls.push(id);
          s.setState({
            tabs: s
              .getState()
              .tabs.map((t) => (t.id === id ? { ...t, archived: true } : t)),
          });
        },
      });
    }, paused);
    await page.waitForTimeout(500);
    const tab = page.locator(
      '[data-chat-drawer-panel] [data-chat-tab="archive-fixture"]',
    );
    for (const patch of [
      { isStreaming: true },
      { isSettling: true },
      { turnPhase: "starting" },
      { pauseState: "pausing" },
    ]) {
      await page.evaluate(async (patch) => {
        const { useAgentChatStore: s } = await import(
          /* @vite-ignore */ "/src/renderer/stores/agent-chat-store.ts"
        );
        s.setState({
          tabs: s
            .getState()
            .tabs.map((t) =>
              t.id === "archive-fixture" ? { ...t, ...patch } : t,
            ),
        });
      }, patch);
      await tab.click({ button: "right" });
      await expect(
        page.getByRole("menuitem", { name: "Archive chat", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await page.evaluate(async (paused) => {
        const { useAgentChatStore: s } = await import(
          /* @vite-ignore */ "/src/renderer/stores/agent-chat-store.ts"
        );
        s.setState({
          tabs: s.getState().tabs.map((t) =>
            t.id === "archive-fixture"
              ? {
                  ...t,
                  isStreaming: false,
                  isSettling: false,
                  turnPhase: null,
                  pauseState: paused ? "paused" : null,
                }
              : t,
          ),
        });
      }, paused);
    }
    await page.screenshot({
      path: `/tmp/archive-${paused ? "paused" : "idle"}.png`,
    });
    await tab.hover();
    await tab.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Archive chat", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Confirm", exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(250);
    await page.keyboard.press("Escape");
    if ((await page.evaluate(() => window.archiveCalls)).length)
      throw Error("Cancel archived tab");
    await tab.hover();
    await tab.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Archive chat", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Confirm", exact: true }).click();
    await expect(tab).toHaveCount(0);
    const calls = await page.evaluate(() => window.archiveCalls);
    if (calls.length !== 1 || calls[0] !== "archive-fixture")
      throw Error("Wrong archive target");
  });
}
