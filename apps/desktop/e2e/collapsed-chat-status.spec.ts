import { expect, test, type Page } from "@playwright/test";

async function seed(page: Page, phase: string) {
  await page.evaluate(async (phase) => {
    const resource = performance
      .getEntriesByType("resource")
      .find(
        (item) =>
          new URL(item.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      );
    const { useAgentChatStore } = await import(resource!.name);
    const queueResource = performance
      .getEntriesByType("resource")
      .find(
        (item) =>
          new URL(item.name).pathname ===
          "/src/renderer/stores/agent-review-queue-store.ts",
      );
    const { useAgentReviewQueueStore } = await import(queueResource!.name);
    useAgentReviewQueueStore.setState({ entries: [] });
    const messages = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Previous round answer" }] },
      },
      {
        type: "user",
        message: { content: [{ type: "text", text: "Inspect the paper" }] },
      },
    ];
    if (phase !== "start")
      messages.push({
        type: "assistant",
        message: {
          content: [
            phase === "thinking"
              ? { type: "thinking", thinking: "Reasoning" }
              : {
                  type: "tool_use",
                  id: "read-1",
                  name: "Read",
                  input: {
                    file_path: "/workspace/paper/sections/introduction.tex",
                  },
                },
          ],
        },
      } as any);
    if (phase === "result")
      messages.push({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "read-1",
              content: "Paper contents",
            },
          ],
        },
      } as any);
    useAgentChatStore.setState((state: any) => ({
      messages,
      isStreaming: true,
      tabs: state.tabs.map((tab: any) =>
        tab.id === state.activeTabId
          ? {
              ...tab,
              messages,
              isStreaming: true,
              error: null,
              pauseState: null,
              roundTiming: {
                startIndex: 1,
                elapsedMs: 0,
                runningSince: Date.now(),
                waitingFor: [],
              },
            }
          : tab,
      ),
    }));
  }, phase);
}

test("collapsed current-round status matches expanded tool headers", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 760 });
  await page.goto("/?debug=agent-file-review");
  const toggle = page.getByRole("button", {
    name: "Toggle drawer",
    exact: true,
  });
  await toggle.waitFor();
  const status = page.getByTestId("collapsed-chat-status");
  const timer = page.getByTestId("collapsed-round-timer");
  await seed(page, "start");
  if (
    await page.locator("[data-chat-drawer-panel] [data-chat-messages]").count()
  )
    await page.getByRole("button", { name: "Mini", exact: true }).click();
  await expect(status).toHaveText("Working...");
  await expect(timer).toHaveText(/^\d+s$/);
  await expect(timer).not.toHaveText("0s");
  await page.screenshot({
    path: testInfo.outputPath("collapsed-working-timer.png"),
  });
  await seed(page, "thinking");
  await expect(status).toHaveText("Working...");
  await expect(timer).toHaveText(/^\d+s$/);
  await seed(page, "tool");
  await expect(status).toHaveText(
    "Reading /workspace/paper/sections/introduction.tex",
  );
  await expect(timer).toBeVisible();
  await expect(timer).not.toHaveText("0s");
  await page.screenshot({ path: testInfo.outputPath("collapsed-tool.png") });
  await toggle.click();
  await expect(
    page
      .getByText("Reading", { exact: false })
      .filter({ has: page.locator("code") })
      .last(),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("expanded-tool.png") });
  await page.getByRole("button", { name: "Mini", exact: true }).click();
  await seed(page, "result");
  await expect(status).toHaveText(
    "Read /workspace/paper/sections/introduction.tex",
  );
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await page.setViewportSize({ width: 480, height: 760 });
  await expect(status).toBeVisible();
  await expect(timer).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("collapsed-narrow.png") });
});

test("archives a paused refinement through the visible archive action", async ({
  page,
}, testInfo) => {
  await page.goto("/?debug=agent-file-review");
  const toggle = page.getByRole("button", {
    name: "Toggle drawer",
    exact: true,
  });
  await toggle.waitFor();
  await seed(page, "tool");
  const id = await page.evaluate(async () => {
    const resource = (name: string) =>
      performance
        .getEntriesByType("resource")
        .find(
          (entry) =>
            new URL(entry.name).pathname === `/src/renderer/stores/${name}.ts`,
        )!.name;
    const { useAgentChatStore: chat } = await import(
      resource("agent-chat-store")
    );
    const { useAgentReviewQueueStore: queue } = await import(
      resource("agent-review-queue-store")
    );
    const id = chat.getState().activeTabId;
    const session = {
      ...chat.getState().tabs.find((tab: any) => tab.id === id).agentWorkspace,
      status: "active",
    };
    const native = (window as any).__TAURI_INTERNALS__;
    const original = native.invoke;
    (window as any).__archiveCommands = [];
    native.invoke = (command: string, args: any) => {
      (window as any).__archiveCommands.push(command);
      if (command === "save_shared_session")
        return Promise.resolve({ shared_session_id: "archive-demo" });
      if (command === "set_shared_session_archived")
        return Promise.resolve({
          shared_session_id: "archive-demo",
          archived: true,
        });
      return original(command, args);
    };
    chat.setState((state: any) => ({
      isStreaming: false,
      tabs: state.tabs.map((tab: any) =>
        tab.id === id
          ? {
              ...tab,
              sharedSessionId: "archive-demo",
              isStreaming: false,
              isSettling: false,
              turnPhase: null,
              pauseState: "paused",
              agentWorkspace: session,
            }
          : tab,
      ),
    }));
    queue.setState({
      entries: [{ session, phase: "revising", conflicts: [] }],
    });
    chat.setState((state: any) => {
      const base = state.tabs.find((tab: any) => tab.id === id);
      const neighbor = (suffix: string) => ({
        ...base,
        id: suffix,
        title: suffix,
        sharedSessionId: suffix,
        agentWorkspace: null,
        pauseState: null,
        roundTiming: null,
      });
      return { tabs: [neighbor("Left chat"), base, neighbor("Right chat")] };
    });
    return id;
  });
  if (await page.getByTestId("collapsed-chat-status").count())
    await toggle.click();
  const tab = page.locator(`[data-tab-id="${id}"]`);
  const setReviewPhase = async (phase: string) =>
    page.evaluate(async (phase) => {
      const resource = performance
        .getEntriesByType("resource")
        .find(
          (entry) =>
            new URL(entry.name).pathname ===
            "/src/renderer/stores/agent-review-queue-store.ts",
        )!;
      const { useAgentReviewQueueStore } = await import(resource.name);
      useAgentReviewQueueStore.setState((state: any) => ({
        entries: state.entries.map((entry: any) => ({ ...entry, phase })),
      }));
    }, phase);
  await setReviewPhase("review");
  await expect(
    tab
      .locator("..")
      .getByRole("button", { name: "Archive chat", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("paused-acceptance-no-archive.png"),
  });
  await setReviewPhase("revising");
  await tab.hover();
  await tab
    .locator("..")
    .getByRole("button", { name: "Archive chat", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm archive", exact: true })
    .click();
  await expect(tab).toHaveCount(0);
  const cleanup = await page.evaluate(async (id) => {
    const resource = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      )!;
    const { useAgentChatStore } = await import(resource.name);
    const tab = useAgentChatStore
      .getState()
      .tabs.find((tab: any) => tab.id === id);
    return {
      activeTabId: useAgentChatStore.getState().activeTabId,
      archived: tab.archived,
      workspace: tab.agentWorkspace,
      pause: tab.pauseState,
      commands: (window as any).__archiveCommands,
    };
  }, id);
  expect(cleanup).toMatchObject({
    activeTabId: "Right chat",
    archived: true,
    workspace: null,
    pause: null,
  });
  expect(cleanup.commands).toContain("discard_agent_workspace");
  expect(cleanup.commands.indexOf("discard_agent_workspace")).toBeLessThan(
    cleanup.commands.indexOf("set_shared_session_archived"),
  );
  await page.screenshot({
    path: testInfo.outputPath("paused-refinement-archived.png"),
  });
});

test("interrupted refinement explains waiting reviews and links back to the holder", async ({
  page,
}, testInfo) => {
  await page.goto("/?debug=agent-file-review");
  const toggle = page.getByRole("button", {
    name: "Toggle drawer",
    exact: true,
  });
  await toggle.waitFor();
  if (
    !(await page
      .locator("[data-chat-drawer-panel] [data-chat-messages]")
      .count())
  )
    await toggle.click();
  await page.evaluate(async () => {
    const resource = (name: string) =>
      performance
        .getEntriesByType("resource")
        .find(
          (entry) =>
            new URL(entry.name).pathname === `/src/renderer/stores/${name}.ts`,
        )!.name;
    const { useAgentChatStore: chat } = await import(
      resource("agent-chat-store")
    );
    const { useAgentReviewQueueStore: queue } = await import(
      resource("agent-review-queue-store")
    );
    const base = chat
      .getState()
      .tabs.find((tab: any) => tab.id === chat.getState().activeTabId);
    const session = base.agentWorkspace;
    chat.setState({
      isStreaming: false,
      tabs: [
        {
          ...base,
          title: "Shorten paper",
          isStreaming: false,
          pauseState: "paused",
          turnPhase: null,
        },
        {
          ...base,
          id: "waiting-chat",
          title: "Check citations",
          isStreaming: false,
          pauseState: null,
          agentWorkspace: {
            ...session,
            tabId: "waiting-chat",
            sessionId: "waiting-draft",
          },
        },
      ],
    });
    queue.setState({
      entries: [{ session, phase: "revising", conflicts: [] }],
    });
    (window as any).__reviewStatusDemo = { chat, queue, session };
  });
  const hold = page
    .locator("[data-chat-drawer-panel]")
    .getByText("Draft kept · Other reviews are waiting", {
      exact: true,
    })
    .filter({ visible: true });
  await expect(hold).toHaveCount(0);
  await page.evaluate(() => {
    const { queue, session } = (window as any).__reviewStatusDemo;
    queue.setState((s: any) => ({
      entries: [
        ...s.entries,
        {
          session: {
            ...session,
            tabId: "waiting-chat",
            sessionId: "waiting-draft",
          },
          phase: "queued",
          conflicts: [],
        },
      ],
    }));
  });
  await expect(hold).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("review-hold-expanded.png"),
  });
  await page.getByRole("button", { name: "Mini", exact: true }).click();
  await expect(hold).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("review-hold-collapsed.png"),
  });
  await page.evaluate(() =>
    (window as any).__reviewStatusDemo.chat
      .getState()
      .setActiveTab("waiting-chat"),
  );
  const notice = page.locator(
    "[data-chat-drawer-panel] [data-agent-draft-notice]:visible",
  );
  await expect(notice).toHaveText("Waiting for review of Shorten paper");
  await page.screenshot({
    path: testInfo.outputPath("review-waiting-link.png"),
  });
  await notice
    .getByRole("button", { name: "Shorten paper", exact: true })
    .click();
  await expect(hold).toBeVisible();
  await page.evaluate(() => {
    const { chat } = (window as any).__reviewStatusDemo;
    chat.setState((s: any) => ({
      isStreaming: true,
      tabs: s.tabs.map((tab: any) =>
        tab.id === s.activeTabId
          ? { ...tab, isStreaming: true, pauseState: null }
          : tab,
      ),
    }));
  });
  await expect(hold).toHaveCount(0);
});
