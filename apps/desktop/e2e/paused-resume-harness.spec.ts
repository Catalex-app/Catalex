import { expect, test } from "@playwright/test";

for (const hasEdits of [true, false]) {
  test(`paused resume choices with ${hasEdits ? "unfinished edits" : "no edits"}`, async ({
    page,
  }) => {
    await page.goto("/?debug=comment-workspace");
    await expect(page.locator(".cm-editor").first()).toBeVisible();
    await page.evaluate(async (hasEdits) => {
      const loaded = (path: string) =>
        performance
          .getEntriesByType("resource")
          .map((item) => item.name)
          .find((url) => new URL(url).pathname === path) ?? path;
      const { useAgentChatStore } = await import(
        loaded("/src/renderer/stores/agent-chat-store.ts")
      );
      const { usePausedReviewStore } = await import(
        loaded("/src/renderer/stores/paused-review-store.ts")
      );
      const id = useAgentChatStore.getState().activeTabId;
      const session = {
        version: 2,
        sessionId: "paused-demo",
        projectRoot: "/browser-demo/Comment Review",
        tabId: id,
        mode: "ask",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        sourceCommit: "fixture-source",
        baselineCommit: "fixture-baseline",
        candidateRoot: "/demo/draft",
        warnings: [],
      };
      useAgentChatStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id
            ? {
                ...t,
                agentWorkspace: session,
                pauseState: "paused",
                isStreaming: false,
              }
            : t,
        ),
      }));
      usePausedReviewStore.setState({
        pending: {
          [id]: {
            session,
            prompt: "continue",
            inspection: {
              changed: true,
              revision: "demo",
              changes: hasEdits
                ? [
                    {
                      id: "one",
                      filePath: "manuscript.md",
                      oldContent: "old",
                      newContent: "proposed",
                      kind: "modified",
                    },
                  ]
                : [],
            },
          },
        },
      });
    }, hasEdits);
    await expect(
      page
        .getByText("The document changed while this agent was paused.", {
          exact: false,
        })
        .last(),
    ).toBeVisible();
    await expect(
      page.getByText("Stay paused", { exact: true }).last(),
    ).toBeVisible();
    if (hasEdits) {
      await expect(
        page.getByText("Update the draft", { exact: true }).last(),
      ).toBeVisible();
      await expect(
        page.getByText("Review the saved draft first", { exact: true }).last(),
      ).toBeVisible();
    } else {
      await expect(
        page
          .getByText("Continue from the current document", { exact: true })
          .last(),
      ).toBeVisible();
      await expect(
        page.getByText("Review the saved draft first", { exact: true }),
      ).toHaveCount(0);
    }
    await page.screenshot({
      path: `test-results/paused-resume-${hasEdits ? "edits" : "empty"}.png`,
    });
    await page
      .getByRole("button", { name: "Stay paused", exact: true })
      .last()
      .click();
    await expect(page.getByText("Stay paused", { exact: true })).toHaveCount(0);
  });
}

test("retiring an old paused draft preserves chat and time and shows the existing toast", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace");
  await expect(page.locator(".cm-editor").first()).toBeVisible();
  const result = await page.evaluate(async () => {
    const loaded = (path: string) =>
      performance
        .getEntriesByType("resource")
        .map((item) => item.name)
        .find((url) => new URL(url).pathname === path) ?? path;
    const { useAgentChatStore } = await import(
      loaded("/src/renderer/stores/agent-chat-store.ts")
    );
    const { useDocumentStore } = await import(
      loaded("/src/renderer/stores/document-store.ts")
    );
    const { usePausedReviewStore } = await import(
      loaded("/src/renderer/stores/paused-review-store.ts")
    );
    const { useAgentReviewQueueStore } = await import(
      loaded("/src/renderer/stores/agent-review-queue-store.ts")
    );
    const { recoverLatestAgentWorkspace } = await import(
      loaded("/src/renderer/lib/agent-workspace.ts")
    );
    const root = useDocumentStore.getState().projectRoot;
    const id = useAgentChatStore.getState().activeTabId;
    const old = {
      version: 1,
      sessionId: "old-copy",
      projectRoot: root,
      tabId: id,
      mode: "ask",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      candidateRoot: "/old/candidate",
      warnings: [],
    };
    const messages = useAgentChatStore
      .getState()
      .tabs.find((t) => t.id === id).messages;
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id
          ? {
              ...tab,
              agentWorkspace: old,
              pauseState: "paused",
              roundTiming: {
                elapsedMs: 4200,
                runningSince: null,
                startIndex: 0,
                waitingFor: [],
              },
            }
          : tab,
      ),
    }));
    useAgentReviewQueueStore.setState({
      entries: [{ session: old, phase: "queued" }],
    });
    usePausedReviewStore.setState({ pending: {}, backups: { [id]: [old] } });
    const harness = (window as any).__TAURI_INTERNALS__;
    const original = harness.invoke;
    harness.invoke = (command, args) =>
      command === "list_agent_workspaces"
        ? Promise.resolve([{ ...old, status: "cancelled" }])
        : original(command, args);
    try {
      await recoverLatestAgentWorkspace(root);
    } finally {
      harness.invoke = original;
    }
    const tab = useAgentChatStore.getState().tabs.find((t) => t.id === id);
    return {
      sameMessages: tab.messages === messages,
      elapsed: tab.roundTiming.elapsedMs,
      paused: tab.pauseState,
      workspace: tab.agentWorkspace,
      queued: useAgentReviewQueueStore.getState().entries.length,
      backups: usePausedReviewStore.getState().backups[id].length,
    };
  });
  expect(result).toEqual({
    sameMessages: true,
    elapsed: 4200,
    paused: null,
    workspace: null,
    queued: 0,
    backups: 0,
  });
  await expect(
    page.getByText(
      "Old unfinished drafts were discarded. A new request starts from the current project.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .locator("[data-sonner-toast]")
    .last()
    .screenshot({ path: "/tmp/269-retirement-toast.png" });
});
