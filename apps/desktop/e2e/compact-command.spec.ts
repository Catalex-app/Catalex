import { expect, test } from "@playwright/test";

for (const provider of ["claude", "pi"] as const) {
  test(`${provider} compact appears as a built-in command and queues its follow-up`, async ({
    page,
  }, testInfo) => {
    await page.goto("/?debug=claude-models");
    await expect(page.getByRole("button", { name: /Opus 4.8/ })).toBeVisible();
    await page.evaluate(async (provider) => {
      const { useAgentChatStore } = await import(
        performance
          .getEntriesByType("resource")
          .find((entry) => entry.name.includes("/stores/agent-chat-store.ts"))!
          .name
      );
      const { useDocumentStore } = await import(
        performance
          .getEntriesByType("resource")
          .find((entry) => entry.name.includes("/stores/document-store.ts"))!
          .name
      );
      useDocumentStore.setState({ projectRoot: "/fixture" });
      if (provider === "pi") {
        const { useSettingsStore } = await import(
          "/src/renderer/stores/settings-store.ts"
        );
        const { usePiSetupStore } = await import(
          "/src/renderer/stores/pi-setup-store.ts"
        );
        useSettingsStore.getState().setProviderEnabled("pi", true);
        await usePiSetupStore.getState().checkStatus();
      }
      useAgentChatStore.setState((state) => ({
        chatProjectRoot: "/fixture",
        selectedProvider: provider,
        selectedPiModel: JSON.stringify(["provider-a", "reasoning-model"]),
        tabs: state.tabs.map((tab) => ({
          ...tab,
          provider,
          sessionId: "fixture-session",
          providerSessionIds: { [provider]: "fixture-session" },
        })),
      }));
    }, provider);
    const input = page.locator("textarea").first();
    await input.fill("/comp");
    await expect(
      page.getByText("Built-in command", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      ),
    );
    await page.screenshot({ path: testInfo.outputPath("compact-menu.png") });
    await page
      .getByRole("button", { name: /\/compact.*Compact context/ })
      .click();
    await input.fill("/compact Fix the tests");
    await input.press("Escape");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const state = await page.evaluate(async () => {
      const { useAgentChatStore } = await import(
        performance
          .getEntriesByType("resource")
          .find((entry) => entry.name.includes("/stores/agent-chat-store.ts"))!
          .name
      );
      return useAgentChatStore.getState().tabs;
    });
    expect(state[0].error).toBeNull();
    expect(state[0].compacting).toBe(true);
    await expect(input).toHaveValue("");
    await expect(
      page.getByText("Fix the tests", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => {})),
      ),
    );
    await page.screenshot({ path: testInfo.outputPath("compact-queued.png") });
  });
}
