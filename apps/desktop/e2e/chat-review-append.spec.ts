import { expect, test } from "@playwright/test";

for (const action of ["keepAll", "undoAll"] as const) {
  test(`${action} records a restored draft decision without hydrating the chat`, async ({
    page,
  }) => {
    await page.goto("/?debug=agent-file-review");
    await page
      .getByRole("button", { name: "Toggle drawer", exact: true })
      .waitFor();
    const result = await page.evaluate(async (action) => {
      const resource = (name: string) =>
        performance
          .getEntriesByType("resource")
          .find(
            (item) => new URL(item.name).pathname === `/src/renderer/${name}`,
          )!.name;
      const { useAgentChatStore } = await import(
        resource("stores/agent-chat-store.ts")
      );
      const { useProposedChangesStore } = await import(
        resource("stores/proposed-changes-store.ts")
      );
      const { saveProjectChats } = await import(
        "/src/renderer/lib/project-chat-lifecycle.ts"
      );
      const store = useAgentChatStore;
      const state = store.getState();
      const original = state.tabs.find(
        (tab: any) => tab.id === state.activeTabId,
      );
      const messages = [
        ...Array.from({ length: 10000 }, () => ({
          type: "system",
          subtype: "init",
        })),
        ...original.messages,
      ];
      store.setState({ tabs: [{ ...original, messages }], messages });
      await saveProjectChats();
      store.setState({
        tabs: [
          { ...original, history: { total: messages.length, start: 10000 } },
        ],
        messages: original.messages,
      });
      const bridge = (window as any).__TAURI_INTERNALS__;
      const invoke = bridge.invoke;
      const commands: string[] = [];
      bridge.invoke = async (command: string, ...args: any[]) => {
        commands.push(command);
        return invoke(command, ...args);
      };
      await useProposedChangesStore.getState()[action]();
      const tab = store.getState().tabs[0];
      return {
        commands,
        error: tab.error,
        history: tab.history,
        decisions: tab.messages.filter(
          (message: any) => message.subtype === "draft_review_decisions",
        ),
        workspace: tab.agentWorkspace,
      };
    }, action);
    expect(result.error).toBeNull();
    expect(result.workspace).toBeNull();
    expect(result.decisions).toHaveLength(1);
    expect(result.commands).toContain("desktop:chat:append-review");
    expect(result.commands).not.toContain("desktop:chat:messages");
    expect(result.commands).not.toContain("save_shared_session");
    expect(result.history.start).toBe(10000);
    await page.screenshot({ path: `/tmp/chat-review-${action}.png` });
  });
}
