import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import {
  recoverLatestAgentWorkspace,
  type AgentWorkspaceSession,
} from "@/lib/agent-workspace";

const mocks = vi.hoisted(() => ({
  chat: {} as any,
  queue: {} as any,
  doc: { projectRoot: "/project" },
  clear: vi.fn(),
  paused: { pending: {}, backups: {} } as any,
  save: vi.fn(),
  flush: vi.fn(),
  notice: vi.fn(),
}));
vi.mock("@/lib/desktop/core", () => ({ invoke: vi.fn() }));
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: { getState: () => mocks.doc },
}));
vi.mock("@/stores/agent-chat-store", () => ({
  useAgentChatStore: { getState: () => mocks.chat },
}));
vi.mock("@/stores/proposed-changes-store", () => ({
  useProposedChangesStore: {
    getState: () => ({
      clearWorkspaceReview: mocks.clear,
      workspaceReviewsByProject: {},
    }),
  },
}));
vi.mock("@/stores/agent-review-queue-store", () => ({
  useAgentReviewQueueStore: {
    getState: () => mocks.queue,
    setState: (update: any) =>
      Object.assign(
        mocks.queue,
        typeof update === "function" ? update(mocks.queue) : update,
      ),
  },
}));

vi.mock("@/stores/paused-review-store", () => ({
  usePausedReviewStore: {
    getState: () => mocks.paused,
    setState: (update: any) => Object.assign(mocks.paused, update),
  },
}));
vi.mock("@/lib/project-chat-lifecycle", () => ({
  saveProjectChats: mocks.save,
}));
vi.mock("@/lib/workspace-state-storage", () => ({
  flushWorkspaceState: mocks.flush,
}));
vi.mock("sonner", () => ({
  toast: { info: mocks.notice, warning: mocks.notice },
}));

function workspace(
  id: string,
  updatedAt: number,
  sharedSessionId?: string,
): AgentWorkspaceSession {
  return {
    version: 2,
    sessionId: id,
    projectRoot: "/project",
    tabId: `old-${id}`,
    sharedSessionId,
    mode: "edit",
    status: "review",
    createdAt: updatedAt,
    updatedAt,
    sourceCommit: "fixture-source",
    baselineCommit: "fixture-baseline",
    candidateRoot: `/${id}/candidate`,
    warnings: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.doc.projectRoot = "/project";
  mocks.paused = { pending: {}, backups: {} };
  mocks.chat = {
    activeTabId: "original",
    tabs: [{ id: "original", sharedSessionId: "unrelated" }],
    createTab: vi.fn(() => {
      const id = `new-${mocks.chat.tabs.length}`;
      mocks.chat.tabs.push({ id });
      mocks.chat.activeTabId = id;
      return id;
    }),
    resumeSession: vi.fn(async (id: string) => {
      mocks.chat.tabs.find(
        (tab: any) => tab.id === mocks.chat.activeTabId,
      ).sharedSessionId = id;
    }),
    _retireLegacyWorkspace: vi.fn((id: string) => {
      const tab = mocks.chat.tabs.find((tab: any) => tab.id === id);
      if (tab && (!tab.agentWorkspace || tab.agentWorkspace.version === 1))
        Object.assign(tab, { agentWorkspace: null, pauseState: null });
    }),
    _setAgentWorkspace: vi.fn((id: string, session: AgentWorkspaceSession) => {
      mocks.chat.tabs.find((tab: any) => tab.id === id).agentWorkspace =
        session;
    }),
    setActiveTab: vi.fn((id: string) => {
      mocks.chat.activeTabId = id;
    }),
    requestDrawerOpen: vi.fn(),
  };
  mocks.queue = {
    entries: [],
    advance: vi.fn(async () => {}),
    show: vi.fn(async () => {}),
  };
});

describe("multiple sandbox recovery", () => {
  it("restores every draft in ready order without guessing a conversation", async () => {
    const first = workspace("first", 1, "known");
    const second = workspace("second", 2);
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "list_agent_workspaces") return [second, first];
      const session = [first, second].find(
        (item) => item.sessionId === (args as { sessionId: string }).sessionId,
      )!;
      return { session: { ...session, status: "failed" }, changes: [] };
    });
    mocks.queue.entries = [
      { session: second, phase: "applying", preview: {} },
      { session: first, phase: "checking" },
    ];
    expect(await recoverLatestAgentWorkspace("/project")).toBe(true);
    expect(
      mocks.queue.entries.map((entry: any) => entry.session.sessionId),
    ).toEqual(["first", "second"]);
    expect(
      mocks.queue.entries.every(
        (entry: any) => entry.phase === "queued" && !entry.preview,
      ),
    ).toBe(true);
    expect(mocks.chat.resumeSession).toHaveBeenCalledExactlyOnceWith("known", {
      useSessionLlm: true,
    });
    expect(mocks.chat.tabs[0].agentWorkspace).toBeUndefined();
    expect(mocks.chat.activeTabId).toBe("original");
    expect(mocks.queue.advance).toHaveBeenCalledExactlyOnceWith("/project");
    expect(invoke).not.toHaveBeenCalledWith(
      "list_shared_sessions",
      expect.anything(),
    );
  });

  it("marks an interrupted active sandbox failed before putting it in review", async () => {
    const session = {
      ...workspace("interrupted", 1, "known"),
      status: "active" as const,
    };
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "list_agent_workspaces"
        ? [session]
        : { session: { ...session, status: "failed" }, changes: [] },
    );
    expect(await recoverLatestAgentWorkspace("/project")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("reconcile_agent_workspace", {
      projectRoot: "/project",
      sessionId: "interrupted",
      outcome: "failed",
    });
    expect(mocks.queue.entries[0].session.status).toBe("failed");
    expect(
      mocks.chat.tabs.find((tab: any) => tab.agentWorkspace)?.agentWorkspace
        .status,
    ).toBe("failed");
  });

  it("recovers a stopped draft if the app exits before reconciliation completes", async () => {
    const session = {
      ...workspace("stopped", 1, "known"),
      status: "active" as const,
    };
    mocks.chat.tabs[0].agentWorkspace = session;
    mocks.chat.tabs[0].sharedSessionId = "known";
    mocks.chat.tabs[0].isStreaming = false;
    mocks.chat.tabs[0].pauseState = null;
    vi.mocked(invoke).mockImplementation(async (cmd) =>
      cmd === "list_agent_workspaces"
        ? [session]
        : { session: { ...session, status: "failed" }, changes: [] },
    );
    expect(await recoverLatestAgentWorkspace("/project")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("reconcile_agent_workspace", {
      projectRoot: "/project",
      sessionId: "stopped",
      outcome: "failed",
    });
    expect(mocks.queue.entries[0].session.status).toBe("failed");
  });

  it("recovers an idle interrupted refinement while preserving its approval snapshots", async () => {
    const session = {
      ...workspace("refining", 1, "known"),
      status: "active" as const,
    };
    mocks.chat.tabs[0].agentWorkspace = session;
    mocks.chat.tabs[0].sharedSessionId = "known";
    const refinementDecisions = {
      "modified:main.tex": { accept: true, revision: "v1" },
    };
    mocks.queue.entries = [
      { session, phase: "revising", refinementDecisions, refinementRound: 2 },
    ];
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "list_agent_workspaces"
        ? [session]
        : { session: { ...session, status: "failed" }, changes: [] },
    );
    expect(await recoverLatestAgentWorkspace("/project")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("reconcile_agent_workspace", {
      projectRoot: "/project",
      sessionId: "refining",
      outcome: "failed",
    });
    expect(mocks.queue.entries[0]).toMatchObject({
      phase: "queued",
      refinementDecisions,
      refinementRound: 2,
    });
    expect(mocks.chat.createTab).not.toHaveBeenCalled();
  });

  it.each([
    "running",
    "paused",
  ])("does not recover a %s refinement", async (runtime) => {
    const session = {
      ...workspace("refining", 1, "known"),
      status: "active" as const,
    };
    mocks.chat.tabs[0].agentWorkspace = session;
    mocks.chat.tabs[0].isStreaming = runtime === "running";
    mocks.chat.tabs[0].pauseState = runtime === "paused" ? "paused" : null;
    mocks.queue.entries = [{ session, phase: "revising" }];
    vi.mocked(invoke).mockResolvedValue([session]);
    expect(await recoverLatestAgentWorkspace("/project")).toBe(false);
    expect(mocks.queue.entries[0].phase).toBe("revising");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("preserves a live tab and its queue without recovering it twice", async () => {
    const session = workspace("live", 1, "known");
    mocks.chat.tabs[0].agentWorkspace = session;
    mocks.chat.tabs[0].isStreaming = true;
    const entry = {
      session,
      phase: "review",
      preview: { sourceRevision: "keep" },
    };
    mocks.queue.entries = [entry];
    vi.mocked(invoke).mockResolvedValue([session]);
    expect(await recoverLatestAgentWorkspace("/project")).toBe(false);
    expect(mocks.chat.createTab).not.toHaveBeenCalled();
    expect(mocks.queue.entries[0]).toBe(entry);
  });
  it("restores a paused sandbox without converting it into a failed review", async () => {
    const session = { ...workspace("paused", 1, "shared"), status: "active" };
    mocks.chat.tabs[0] = {
      id: session.tabId,
      sharedSessionId: "shared",
      pauseState: "paused",
      agentWorkspace: session,
    };
    vi.mocked(invoke).mockResolvedValue([session]);
    await recoverLatestAgentWorkspace("/project");
    expect(invoke).not.toHaveBeenCalledWith(
      "reconcile_agent_workspace",
      expect.anything(),
    );
    expect(mocks.chat.createTab).not.toHaveBeenCalled();
    expect(mocks.chat.tabs[0].agentWorkspace).toBe(session);
  });

  it.each([
    "review",
    "question",
  ])("preserves a saved %s and its edited contents", async (phase) => {
    const session = workspace("review", 1, "shared");
    mocks.chat.tabs[0] = {
      id: session.tabId,
      sharedSessionId: "shared",
      agentWorkspace: session,
    };
    const entry = {
      session,
      phase,
      conflicts: [{ changeId: "conflict" }],
      editedContents: { changed: "user edit" },
      excludedChangeIds: ["skipped"],
      preview: { sourceRevision: "original" },
    };
    mocks.queue.entries = [entry];
    vi.mocked(invoke).mockResolvedValue([session]);
    await recoverLatestAgentWorkspace("/project");
    expect(mocks.queue.entries[0]).toBe(entry);
    expect(mocks.chat.createTab).not.toHaveBeenCalled();
    if (phase === "review")
      expect(mocks.queue.show).toHaveBeenCalledWith(session.sessionId);
    else expect(mocks.queue.show).not.toHaveBeenCalled();
  });
});

it("retires old queued and paused references, persists cleanup and preserves current drafts", async () => {
  const old = { ...workspace("old", 1), version: 1 };
  const current = workspace("current", 2);
  mocks.chat.tabs = [
    {
      id: "original",
      agentWorkspace: old,
      pauseState: "paused",
      messages: ["conversation"],
      roundTiming: { elapsedMs: 500 },
    },
    { id: "current", agentWorkspace: current },
  ];
  mocks.queue.entries = [
    { session: old, phase: "revising" },
    { session: current, phase: "queued" },
  ];
  mocks.paused.pending = { original: { session: old } };
  mocks.paused.backups = { original: [old, current] };
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "list_agent_workspaces" ? [old, current] : undefined,
  );
  await recoverLatestAgentWorkspace("/project");
  expect(mocks.chat._retireLegacyWorkspace).toHaveBeenCalledWith("original");
  expect(mocks.chat.tabs[0].messages).toEqual(["conversation"]);
  expect(mocks.chat.tabs[0].roundTiming.elapsedMs).toBe(500);
  expect(mocks.queue.entries.map((e: any) => e.session.sessionId)).toEqual([
    "current",
  ]);
  expect(mocks.paused.pending).toEqual({});
  expect(mocks.paused.backups.original).toEqual([current]);
  expect(mocks.save).toHaveBeenCalled();
  expect(mocks.flush).toHaveBeenCalled();
  expect(mocks.notice).toHaveBeenCalledTimes(1);
  vi.mocked(invoke).mockResolvedValue([current]);
  await recoverLatestAgentWorkspace("/project");
  expect(mocks.notice).toHaveBeenCalledTimes(1);
});

it("keeps a settled pending checkpoint out of the review queue", async () => {
  const settled = {
    ...workspace("settled", 1),
    status: "settled",
    warnings: ["History checkpoint pending: storage unavailable"],
  };
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "list_agent_workspaces" ? [settled] : undefined,
  );
  expect(await recoverLatestAgentWorkspace("/project")).toBe(false);
  expect(mocks.queue.entries).toEqual([]);
  expect(mocks.notice).toHaveBeenCalledWith(
    "A history checkpoint could not be saved. Reopen the project to retry.",
    expect.anything(),
  );
});
