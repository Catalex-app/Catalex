import { expect, test } from "@playwright/test";

for (const provider of ["claude", "codex"] as const) {
  test(`manual Stop ends ${provider} without a paused return on reopening`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/?debug=agent-pause&provider=${provider}`);
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(
      page.getByRole("button", { name: "Stopping…", exact: true }),
    ).toBeDisabled();
    await expect(page.getByTestId("pause-status")).toHaveText("idle");
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Send", exact: true }),
    ).toBeDisabled();
    await expect(page.getByTestId("provider-calls")).toHaveText(
      `cancel_${provider}_execution (pause-tab)`,
    );
    await page.screenshot({
      path: testInfo.outputPath(`${provider}-stopped.png`),
    });
    await page
      .getByRole("button", { name: "Back to welcome", exact: true })
      .click();
    await expect(page.getByTestId("welcome")).toBeVisible();
    await page
      .getByRole("button", { name: "Reopen project", exact: true })
      .click();
    const saved = await page.evaluate(() => {
      const state = (window as any).__agentPauseChatStore.getState();
      const stopped = state.tabs.find((tab: any) => tab.id === "pause-tab");
      return {
        focus: state.activeTabId,
        paused: stopped.pauseState,
        archived: stopped.archived,
        messages: stopped.history?.total ?? stopped.messages.length,
        workspace: stopped.agentWorkspace,
      };
    });
    expect(saved).toMatchObject({
      paused: null,
      archived: false,
      workspace: null,
    });
    expect(saved.messages).toBe(2);
    expect(saved.focus).not.toBe("pause-tab");
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toHaveCount(0);
    await page.evaluate(async () => {
      const store = (window as any).__agentPauseChatStore.getState();
      await store.loadHistory("pause-tab");
      store.setActiveTab("pause-tab");
    });
    await expect(
      page.getByText("Review the introduction and improve its clarity.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${provider}-reopened-after-stop.png`),
    });
  });

  test(`closing running ${provider} work restores a paused chat and explicit Continue`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/?debug=agent-pause&provider=${provider}`);
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Back to welcome", exact: true })
      .click();
    await expect(page.getByTestId("welcome")).toBeVisible();
    await page
      .getByRole("button", { name: "Reopen project", exact: true })
      .click();
    await expect(page.getByTestId("pause-status")).toHaveText("paused");
    const resume = page.getByRole("button", { name: "Continue", exact: true });
    await expect(resume).toBeEnabled();
    await expect(
      page.getByText("Review the introduction and improve its clarity.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as any).__agentPauseChatStore.getState().activeTabId,
      ),
    ).toBe("pause-tab");
    await page.screenshot({
      path: testInfo.outputPath(`${provider}-paused-on-reopen.png`),
    });
    await resume.click();
    await expect(page.getByTestId("provider-calls")).toContainText(
      `resume_${provider}_code (native-session)`,
    );
    await expect(page.getByTestId("pause-status")).toHaveText("working");
  });
}
