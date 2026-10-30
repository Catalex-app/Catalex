import { expect, test, type Page } from "@playwright/test";

async function chatAction(page: Page, action: string) {
  return page.evaluate(async (action) => {
    const useAgentChatStore = (window as any)
      .__agentPauseChatStore as typeof import("../src/renderer/stores/agent-chat-store").useAgentChatStore;
    const store = useAgentChatStore.getState();
    const id = "pause-tab";
    if (action === "seed") {
      useAgentChatStore.setState((state: typeof store) => ({
        tabs: state.tabs.map((tab) => ({
          ...tab,
          roundTiming: {
            elapsedMs: 0,
            runningSince: Date.now(),
            waitingFor: [],
            startIndex: 0,
          },
        })),
      }));
    } else if (action === "away") {
      store.createTab();
    } else if (action === "back") {
      store.setActiveTab(id);
    } else if (action === "pause") {
      await store.pauseExecution(id);
    } else if (action === "continue") {
      void store.continueExecution();
    } else if (action === "question") {
      store._setRoundWaiting(id, "test-question", true);
    } else if (action === "answer") {
      store._setRoundWaiting(id, "test-question", false);
    } else if (action === "finish") {
      store._setAgentWorkspace(id, null);
      store._appendMessage(id, {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "The review is complete." }],
        },
      });
      const provider = store.tabs.find((tab) => tab.id === id)!.provider;
      await (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: `${provider}-complete`,
        payload: { tab_id: id, success: true },
      });
    }
  }, action);
}

for (const provider of ["claude", "codex"]) {
  test(`${provider} each stopped round keeps its duration and Continue starts a new timer`, async ({
    page,
  }, testInfo) => {
    await page.clock.install();
    await page.setViewportSize({
      width: provider === "claude" ? 480 : 900,
      height: 760,
    });
    await page.goto(`/?debug=agent-pause&provider=${provider}`);
    await expect(page.getByTestId("pause-status")).toHaveText("working");
    await chatAction(page, "seed");
    const timer = page.getByTestId("round-timer");
    await page.clock.fastForward(6000);
    await expect(timer).toHaveText("Working...6s");
    await chatAction(page, "away");
    await page.clock.fastForward(10000);
    await chatAction(page, "back");
    await expect(timer).toHaveText("Working...16s");
    await chatAction(page, "pause");
    await page.clock.fastForward(1000);
    await expect(page.getByTestId("pause-status")).toHaveText("paused");
    await page.clock.runFor(100);
    await expect(timer).toHaveText("Paused");
    const paused = await timer.textContent();
    await page.clock.fastForward(60000);
    await expect(timer).toHaveText(paused!);
    await page.clock.runFor(100);
    await expect(
      page.getByText("I’m reviewing the introduction.", { exact: false }),
    ).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("paused.png") });
    const stoppedDuration = page.getByTestId("round-duration").first();
    const stoppedText = await stoppedDuration.textContent();
    await expect(stoppedDuration).toBeVisible();
    await chatAction(page, "continue");
    await expect(timer).toHaveText("Working...0s");
    await expect(stoppedDuration).toHaveText(stoppedText!);
    await expect(page.getByTestId("pause-status")).toHaveText("working");
    await page.clock.fastForward(5000);
    await chatAction(page, "question");
    await expect(timer).toContainText("Waiting for you");
    const waiting = await timer.textContent();
    await page.clock.fastForward(60000);
    await expect(timer).toHaveText(waiting!);
    await chatAction(page, "answer");
    await page.clock.fastForward(4000);
    const elapsed = (await timer.textContent())!.replace("Working...", "");
    await chatAction(page, "finish");
    await expect(timer).toHaveCount(0);
    const duration = page.getByTestId("round-duration").last();
    await expect(duration).toHaveText(`Worked for: ${elapsed}`);
    await expect(
      duration
        .locator("..")
        .getByRole("button", { name: "Fork from this response" }),
    ).toBeVisible();
    await duration.click();
    await expect(duration).toHaveAttribute("aria-pressed", "true");
    const finishedTime = await duration
      .locator("time")
      .getAttribute("datetime");
    await expect(duration).toContainText(/(?:AM|PM)/);
    await page.screenshot({ path: testInfo.outputPath("completed-date.png") });
    await page.clock.fastForward(60000);
    await expect(duration.locator("time")).toHaveAttribute(
      "datetime",
      finishedTime!,
    );
    await duration.press("Space");
    await expect(duration).toHaveAttribute("aria-pressed", "false");
    await expect(duration).toHaveText(`Worked for: ${elapsed}`);
    await chatAction(page, "away");
    await chatAction(page, "back");
    await expect(duration).toHaveText(`Worked for: ${elapsed}`);
    await page.clock.runFor(100);
    if (provider === "codex")
      await page.getByRole("button", { name: "Toggle theme" }).click();
    await page.clock.runFor(500);
    await duration.scrollIntoViewIfNeeded();
    await expect(duration).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("completed.png") });
  });
}

test("answer time display is shared across chats and remembered after reload", async ({
  page,
}, testInfo) => {
  const seedAnswers = async () => {
    await expect(page.getByTestId("pause-status")).toBeVisible();
    await page.evaluate(() => {
      const store = (window as any).__agentPauseChatStore;
      const messages = [
        {
          type: "user",
          message: { content: [{ type: "text", text: "First question" }] },
        },
        {
          type: "assistant",
          roundDurationMs: 26000,
          roundCompletedAt: Date.now() - 60000,
          message: {
            content: [{ type: "text", text: "First completed answer" }],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "text", text: "Second question" }] },
        },
        {
          type: "assistant",
          roundDurationMs: 65000,
          roundCompletedAt: Date.now(),
          message: {
            content: [{ type: "text", text: "Second completed answer" }],
          },
        },
      ];
      store.setState((state: any) => ({
        messages,
        isStreaming: false,
        tabs: state.tabs.map((tab: any) => ({
          ...tab,
          messages,
          isStreaming: false,
          pauseState: null,
          roundTiming: null,
        })),
      }));
    });
  };
  await page.goto("/?debug=agent-pause");
  await seedAnswers();
  const buttons = page.getByTestId("round-duration");
  await expect(buttons).toHaveText(["Worked for: 26s", "Worked for: 1m 5s"]);
  await buttons.first().click();
  await expect(buttons.locator("time")).toHaveCount(2);
  await chatAction(page, "away");
  await chatAction(page, "back");
  await expect(buttons.locator("time")).toHaveCount(2);
  await page.reload();
  await seedAnswers();
  await expect(buttons.locator("time")).toHaveCount(2);
  await buttons.last().scrollIntoViewIfNeeded();
  await expect(page.getByText(/Loading Catalex/)).toBeHidden();
  await expect(buttons.first()).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("shared-date-preference.png"),
  });
  await buttons.last().click();
  await expect(buttons).toHaveText(["Worked for: 26s", "Worked for: 1m 5s"]);
  await page.reload();
  await seedAnswers();
  await expect(buttons).toHaveText(["Worked for: 26s", "Worked for: 1m 5s"]);
});

test("pause before output shows neither a standalone duration nor a paused timer", async ({
  page,
}, testInfo) => {
  await page.goto("/?debug=agent-pause&provider=codex");
  await expect(page.getByTestId("pause-status")).toHaveText("working");
  await page.evaluate(() => {
    const chat = (window as any).__agentPauseChatStore;
    chat.setState((state: any) => ({
      messages: state.messages.filter(
        (message: any) => message.type === "user",
      ),
      tabs: state.tabs.map((tab: any) => ({
        ...tab,
        messages: tab.messages.filter(
          (message: any) => message.type === "user",
        ),
        roundTiming: {
          elapsedMs: 4000,
          runningSince: null,
          startIndex: 0,
          waitingFor: [],
        },
      })),
    }));
  });
  await chatAction(page, "pause");
  await expect(page.getByTestId("pause-status")).toHaveText("paused");
  await expect(page.getByTestId("round-timer")).toHaveText("Paused");
  await expect(page.getByTestId("round-duration")).toHaveCount(0);
  await expect(page.getByTestId("fork-response-action")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("paused-without-output.png"),
  });
});
