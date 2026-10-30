import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import {
  saveProjectChats,
  waitForChatCheckpointWrites,
} from "@/lib/project-chat-lifecycle";
import {
  forkSavedChat,
  cancelSavedFork,
  prepareSavedChatTurn,
  syncSavedChat,
  appendChatReviewDecision,
  loadChatCheckpoint,
  loadChatMessages,
  saveChatCheckpoint,
  includeChatReviewDecisions,
} from "../../main/chat-checkpoints";
let directory: string;
const decision = {
  uuid: "review-one",
  type: "system" as const,
  subtype: "draft_review_decisions",
  message: { content: [{ type: "text" as const, text: "rejected" }] },
};
beforeEach(async () => {
  await waitForChatCheckpointWrites();
  directory = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "review-append-")),
    "checkpoints",
  );
  await fs.mkdir(directory);
  vi.clearAllMocks();
  useDocumentStore.setState({ projectRoot: "/review-test" });
  useAgentChatStore.getState().restoreProjectTabs("/review-test");
  const base = useAgentChatStore.getState().tabs[0];
  const tab = {
    ...base,
    sharedSessionId: "shared",
    messages: [],
    history: { total: 10000, start: 10000 },
  };
  await saveChatCheckpoint(directory, {
    version: 1,
    tabs: [
      {
        ...tab,
        history: undefined,
        messages: Array.from({ length: 10000 }, (_, index) => ({
          type: "assistant",
          uuid: `message-${index}`,
          message: { content: [{ type: "text", text: `message ${index}` }] },
        })),
      },
    ],
  });
  useAgentChatStore.setState({
    tabs: [tab],
    activeTabId: tab.id,
    messages: [],
  });
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "desktop:chat:checkpoint-save")
      return saveChatCheckpoint(directory, args.snapshot);
    if (command === "desktop:chat:append-review")
      return appendChatReviewDecision(
        directory,
        args.tabId,
        args.runtimeSessionKey,
        args.message,
      );
    if (command === "desktop:chat:fork")
      return forkSavedChat(
        directory,
        args.tabId,
        args.runtimeSessionKey,
        args.messageIndex,
        args.tab,
      );
    if (command === "desktop:chat:cancel-fork")
      return cancelSavedFork(directory, args.tabId, args.sharedSessionId);
    if (command === "desktop:chat:prepare-turn")
      return prepareSavedChatTurn(
        directory,
        args.tabId,
        args.runtimeSessionKey,
        args.cursor,
        args.retry,
      );
    if (command === "desktop:chat:sync-shared")
      return syncSavedChat(directory, args.tabId, args.runtimeSessionKey);
    if (command === "desktop:chat:messages")
      return loadChatMessages(directory, args.tabId, args.start, args.limit);
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(async () => {
  await waitForChatCheckpointWrites();
  await fs.rm(path.dirname(directory), { recursive: true, force: true });
});
it("serializes a bounded review append with a concurrent autosave without moving an older page", async () => {
  const store = useAgentChatStore;
  const id = store.getState().activeTabId;
  await store.getState().loadHistory(id, 100, 200);
  vi.mocked(invoke).mockClear();
  const implementation = vi.mocked(invoke).getMockImplementation()!;
  let release!: () => void;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "desktop:chat:append-review")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return implementation(command, args);
  });
  const recording = store.getState()._recordReviewDecision(id, decision);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  store.getState().saveDraft(id, { input: "during save", pinnedContexts: [] });
  const saving = saveProjectChats();
  release();
  await Promise.all([recording, saving]);
  expect(store.getState().tabs[0].history).toEqual({
    total: 10001,
    start: 100,
  });
  expect(store.getState().messages).toHaveLength(200);
  expect(invoke).not.toHaveBeenCalledWith(
    "desktop:chat:messages",
    expect.anything(),
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "save_shared_session",
    expect.anything(),
  );
  expect(await loadChatMessages(directory, id, 10000, 1)).toEqual([decision]);
  expect((await loadChatCheckpoint(directory))!.tabs[0].draft).toMatchObject({
    input: "during save",
  });
  expect(await includeChatReviewDecisions(directory, "shared", [])).toEqual([
    decision,
  ]);
});
it.each([
  false,
  true,
])("recovers an append whose acknowledgement was lost (fully loaded: %s)", async (fullyLoaded) => {
  const store = useAgentChatStore;
  const id = store.getState().activeTabId;
  if (fullyLoaded) await store.getState().loadHistory(id);
  const implementation = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const result = await implementation(command, args);
    if (command === "desktop:chat:append-review")
      throw new Error("lost acknowledgement");
    return result;
  });
  await expect(
    store.getState()._recordReviewDecision(id, decision),
  ).rejects.toThrow("lost acknowledgement");
  if (fullyLoaded) {
    vi.mocked(invoke).mockImplementation(implementation);
    await saveProjectChats();
  }
  const checkpoint = (await loadChatCheckpoint(directory))!;
  if (!fullyLoaded)
    expect(checkpoint.tabs[0].pendingReviewDecisions).toEqual([decision]);
  store.getState().restoreProjectTabs("/review-test", checkpoint.tabs as any);
  vi.mocked(invoke).mockImplementation(implementation);
  await saveProjectChats();
  const restored = (await loadChatCheckpoint(directory))!;
  expect(restored.tabs.find((tab) => tab.id === id)!.history?.total).toBe(
    10001,
  );
  expect(await loadChatMessages(directory, id, 10000, 2)).toEqual([decision]);
  expect(
    store.getState().tabs.find((tab) => tab.id === id)!.pendingReviewDecisions,
  ).toEqual([]);
});
it.each([
  "send",
  "fork",
])("cancels %s when loading overlaps a conversation reset", async (action) => {
  const store = useAgentChatStore;
  let release!: () => void;
  const original = store.getState().loadHistory;
  store.setState({
    loadHistory: vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve;
        }),
    ),
  });
  const implementation = vi.mocked(invoke).getMockImplementation()!;
  if (action === "fork")
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "desktop:chat:fork")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return implementation(command, args);
    });
  try {
    const pending =
      action === "send"
        ? store.getState().sendPrompt("old request")
        : store.getState().forkSessionAtMessage(0);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    store.getState().newSession();
    release();
    await pending;
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().tabs).toHaveLength(1);
    if (action === "send") expect(invoke).not.toHaveBeenCalled();
    else expect((await loadChatCheckpoint(directory))!.tabs).toHaveLength(1);
  } finally {
    store.setState({ loadHistory: original });
  }
});

it.each([
  "switch",
  "reset",
])("does not apply a completed append to a replacement chat (%s)", async (action) => {
  const store = useAgentChatStore;
  const id = store.getState().activeTabId;
  const implementation = vi.mocked(invoke).getMockImplementation()!;
  let release!: () => void;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "desktop:chat:append-review")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return implementation(command, args);
  });
  const recording = store.getState()._recordReviewDecision(id, decision);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  if (action === "switch") store.getState().createTab();
  else store.getState().newSession();
  release();
  await recording;
  expect(store.getState().messages).toEqual([]);
  expect(
    store
      .getState()
      .tabs.find((tab) => tab.id === store.getState().activeTabId)!
      .pendingReviewDecisions,
  ).toBeUndefined();
  expect(await includeChatReviewDecisions(directory, "shared", [])).toEqual([
    decision,
  ]);
});

it("resumes a saved native session with a bounded tail and saves later stream updates in the backend", async () => {
  const store = useAgentChatStore;
  const tab = {
    ...store.getState().tabs[0],
    sessionId: "native",
    provider: "codex" as const,
    providerSessionIds: { codex: "native" },
    providerSyncCursors: { codex: 10000 },
  };
  store.setState({
    tabs: [tab],
    selectedProvider: "codex",
    sessionId: "native",
    isStreaming: false,
    isLeavingProject: false,
  });
  const implementation = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "prepare_agent_workspace")
      throw new Error("stop before live agent startup");
    return implementation(command, args);
  });
  await store.getState().sendPrompt("Continue editing");
  expect(store.getState().messages.length).toBeLessThan(300);
  expect(store.getState().tabs[0].history?.writable).toBe(true);
  expect(store.getState().tabs[0].history?.transcript).toBe("");
  expect(store.getState().tabs[0].sessionId).toBe("native");
  store.getState()._appendMessage(tab.id, {
    type: "assistant",
    uuid: "new-answer",
    message: { content: [{ type: "text", text: "New answer" }] },
  });
  store.getState()._markProviderSynced(tab.id, "codex");
  expect(store.getState().tabs[0].providerSyncCursors.codex).toBe(10002);
  await store.getState()._syncSharedSession(tab.id);
  const saved = JSON.parse(
    await fs.readFile(path.join(directory, "..", "shared.json"), "utf8"),
  );
  // Failed startup also persists the UI-only stopped-round timing marker.
  // Provider synchronization counts conversation messages, not that marker.
  expect(saved.messages).toHaveLength(10003);
  expect(saved.messages.at(-2)).toMatchObject({
    type: "result",
    subtype: "round_stopped",
  });
  expect(saved.messages[0].uuid).toBe("message-0");
  expect(saved.messages.at(-1).uuid).toBe("new-answer");
  expect(invoke).not.toHaveBeenCalledWith(
    "desktop:chat:messages",
    expect.anything(),
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "save_shared_session",
    expect.anything(),
  );
  await store.getState().loadHistory(tab.id, 9600, 600);
  expect(store.getState().messages.slice(-1)[0]?.uuid).toBe("new-answer");
  expect(store.getState().tabs[0].history?.writable).toBeUndefined();
  await store.getState().loadHistory(tab.id, 9000, 600);
  expect(store.getState().tabs[0].messages).toHaveLength(600);
  expect(store.getState().tabs[0].history?.start).toBe(9000);
});

it("keeps live scroll suffixes aligned and preserves updates arriving during the read", async () => {
  const store = useAgentChatStore;
  const tab = store.getState().tabs[0];
  const prepared = await prepareSavedChatTurn(
    directory,
    tab.id,
    tab.runtimeSessionKey,
    10000,
    false,
  );
  const { messages, ...history } = prepared;
  store.setState({
    tabs: [
      {
        ...tab,
        messages: messages as any,
        history: { ...history, writable: true } as any,
        isStreaming: true,
      },
    ],
    messages: messages as any,
  });
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const result = await original(command, args);
    if (command === "desktop:chat:messages")
      store.getState()._appendMessage(tab.id, {
        type: "assistant",
        uuid: "during-read",
        message: { content: [{ type: "text", text: "Live answer" }] },
      });
    return result;
  });
  await store.getState().loadHistory(tab.id, 9573, 600);
  expect(store.getState().tabs[0].history?.start).toBe(9500);
  expect(store.getState().messages.slice(-1)[0].uuid).toBe("during-read");
  await saveProjectChats();
  const saved = (await loadChatMessages(directory, tab.id, 0, 10001)) as any[];
  expect(saved).toHaveLength(10001);
  expect(saved[0].uuid).toBe("message-0");
  expect(saved[9573].uuid).toBe("message-9573");
  expect(saved[10000].uuid).toBe("during-read");
});

it("removes a new fork when its first page cannot be loaded", async () => {
  const store = useAgentChatStore;
  const source = store.getState().tabs[0];
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "desktop:chat:messages" && args.tabId !== source.id)
      throw new Error("page read failed");
    return original(command, args);
  });
  await expect(store.getState().forkSessionAtMessage(9998)).rejects.toThrow(
    "page read failed",
  );
  expect(
    (await loadChatCheckpoint(directory))?.tabs.map((tab) => tab.id),
  ).toEqual([source.id]);
  expect(await fs.readdir(path.join(directory, ".."))).toEqual(["checkpoints"]);
  expect(await loadChatMessages(directory, source.id, 9999, 1)).toHaveLength(1);
});
