import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { writeTexFileContent } from "@/lib/project-files";
import type {
  AgentWorkspacePreview,
  AgentWorkspaceSession,
} from "@/lib/agent-workspace";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";

vi.mock("@/lib/project-files", async (original) => ({
  ...(await original<typeof import("@/lib/project-files")>()),
  writeTexFileContent: vi.fn(),
  readTexFileContent: vi.fn(async () => ""),
}));

const candidate = new Map<string, string>();
function session(id: string): AgentWorkspaceSession {
  return {
    version: 2,
    sessionId: id,
    projectRoot: "/project",
    tabId: id,
    mode: "ask",
    status: "review",
    createdAt: 1,
    updatedAt: 1,
    sourceCommit: "fixture-source",
    baselineCommit: "fixture-baseline",
    candidateRoot: `/${id}/candidate`,
    warnings: [],
  };
}
function preview(id: string): AgentWorkspacePreview {
  const changes = ["approved.tex", "approved.png", "pending.tex"].map(
    (path) => {
      const binary = path.endsWith("png");
      const value = candidate.get(path)!;
      return {
        id: `${id}:${path}`,
        kind: "modified" as const,
        filePath: path,
        oldFilePath: path,
        newFilePath: path,
        oldContent: binary ? null : "before",
        newContent: binary ? null : value,
        binary,
        sourceChanged: false,
        sourceAbsolutePath: `/project/${path}`,
        candidateAbsolutePath: `/${id}/candidate/${path}`,
        proposalRevision: `${path}:${value}`,
      };
    },
  );
  return {
    session: session(id),
    sourceRevision: "unchanged-source",
    changes,
    conflicts: [],
    currentContents: Object.fromEntries(
      changes.map((c) => [c.id, c.oldContent]),
    ),
    mergedContents: Object.fromEntries(
      changes.map((c) => [c.id, c.newContent]),
    ),
  };
}
function files() {
  return ["approved.tex", "pending.tex"].map((path) => ({
    id: path,
    name: path,
    relativePath: path,
    absolutePath: `/a/candidate/${path}`,
    type: "tex" as const,
    content: candidate.get(path)!,
    isDirty: false,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  candidate.clear();
  for (const path of ["approved.tex", "approved.png", "pending.tex"])
    candidate.set(path, `initial-${path}`);
  useAgentReviewQueueStore.setState({ entries: [] });
  useProposedChangesStore.setState({
    changes: [],
    changesByProject: {},
    workspaceReviewsByProject: {},
    workspaceReview: null,
    activeProjectRoot: "/project",
  });
  const initial = useAgentChatStore.getState().tabs[0];
  useAgentChatStore.setState({
    activeTabId: "a",
    selectedProvider: "codex",
    selectedCodexModel: "gpt-5.4",
    selectedCodexExecutionMode: "default",
    isLeavingProject: false,
    messages: [],
    error: null,
    isStreaming: false,
    tabs: ["a", "b"].map((id) => ({
      ...initial,
      id,
      provider: "codex",
      sessionId: null,
      providerSessionIds: {},
      providerSyncCursors: {},
      pendingCrossProviderTranscript: null,
      messages: [],
      isSettling: false,
      turnPhase: null,
      pauseState: null,
      cancelledByUser: false,
      draft: { input: "Refine the remaining change", pinnedContexts: [] },
      isStreaming: false,
      agentWorkspace: session(id),
    })),
  });
  useDocumentStore.setState({
    projectRoot: "/project",
    agentWorkspaceRoot: null,
    agentWorkspaceSessionId: null,
    isAgentWorkspaceReadOnly: false,
    sourceViewSnapshot: null,
    files: [],
    saveAllFiles: vi.fn(async () => {}),
    restoreSourceWorkspace: vi.fn(async () => {
      useDocumentStore.setState({
        agentWorkspaceRoot: null,
        agentWorkspaceSessionId: null,
      });
    }),
    activateAgentWorkspace: vi.fn(async (id, root) => {
      useDocumentStore.setState({
        agentWorkspaceSessionId: id,
        agentWorkspaceRoot: root,
        files: files(),
      });
    }),
    addAgentWorkspaceReviewFiles: vi.fn(async () => {}),
    refreshFiles: vi.fn(async () => {
      useDocumentStore.setState({ files: files() });
    }),
  });
  vi.mocked(writeTexFileContent).mockImplementation(async (path, content) => {
    candidate.set(path.split("/").slice(-1)[0], content);
  });
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "reconcile_agent_workspace")
      return {
        session: session(args.sessionId),
        changes: preview(args.sessionId).changes,
      };
    if (command === "preview_agent_workspace") return preview(args.sessionId);
    if (command === "resume_agent_workspace")
      return { ...session(args.sessionId), status: "active" };
  });
});

// Simulate a persisted staged approval from an earlier review. New file
// acceptances apply immediately; recovery must still honor unchanged decisions.
function stageApproval(id: string) {
  useProposedChangesStore.setState((state) => {
    const review = state.workspaceReview!;
    const next = {
      ...review,
      decisions: { ...review.decisions, [id]: { accept: true } },
    };
    const changes = state.changes.filter((change) => change.id !== id);
    return {
      workspaceReview: next,
      workspaceReviewsByProject: { "/project": next },
      changes,
      changesByProject: { "/project": changes },
    };
  });
}

async function openReview() {
  await useAgentReviewQueueStore.getState().enqueue(session("a"));
  await useAgentReviewQueueStore.getState().enqueue(session("b"));
}

describe("review refinement lifecycle", () => {
  it.each([
    "preview",
    "application",
  ] as const)("does not reactivate the previous project after switching during inline %s", async (stage) => {
    await openReview();
    useProposedChangesStore
      .getState()
      .setReviewedContent("a:pending.tex", "approved portion only");
    const original = vi.mocked(invoke).getMockImplementation()!;
    let switched = false;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (
        !switched &&
        command ===
          (stage === "preview"
            ? "preview_agent_workspace"
            : "apply_agent_workspace")
      ) {
        switched = true;
        useDocumentStore.setState({
          projectRoot: "/other",
          agentWorkspaceSessionId: null,
          agentWorkspaceRoot: null,
        });
        useProposedChangesStore.getState().activateProject("/other");
        if (stage === "application")
          return {
            applied: true,
            conflicts: [],
            changedPaths: ["pending.tex"],
            remainingPreview: preview("a"),
          };
      }
      return original(command, args);
    });
    await expect(
      useAgentReviewQueueStore.getState().beginRefinement("a"),
    ).rejects.toThrow("workspace changed");
    expect(useProposedChangesStore.getState().activeProjectRoot).toBe("/other");
    expect(useProposedChangesStore.getState().workspaceReview).toBeNull();
    expect(
      useProposedChangesStore.getState().workspaceReviewsByProject["/project"]
        .isApplying,
    ).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith(
      "resume_agent_workspace",
      expect.anything(),
    );
    if (stage === "preview")
      expect(invoke).not.toHaveBeenCalledWith(
        "apply_agent_workspace",
        expect.anything(),
      );
  });

  it("commits only the inline reviewed baseline before resuming the pending proposal", async () => {
    await openReview();
    const reviewed = "Accepted first change\nUnresolved original text";
    useProposedChangesStore
      .getState()
      .setReviewedContent("a:pending.tex", reviewed);
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args: any) => {
      if (command === "apply_agent_workspace") {
        expect(args.expectedSourceRevision).toBe("unchanged-source");
        expect(args.decisions).toEqual([
          {
            changeId: "a:pending.tex",
            accept: true,
            partial: true,
            resolvedConflict: true,
            content: reviewed,
            proposalRevision: `pending.tex:${candidate.get("pending.tex")}`,
          },
        ]);
        const remaining = preview("a");
        remaining.sourceRevision = "after-inline-checkpoint";
        remaining.currentContents["a:pending.tex"] = reviewed;
        remaining.changes = remaining.changes.map((change) =>
          change.filePath === "pending.tex"
            ? { ...change, oldContent: reviewed }
            : change,
        );
        return {
          applied: true,
          conflicts: [],
          changedPaths: ["pending.tex"],
          remainingPreview: remaining,
        };
      }
      return original(command, args);
    });
    const result = await useAgentReviewQueueStore
      .getState()
      .beginRefinement("a");
    const commands = vi.mocked(invoke).mock.calls.map(([command]) => command);
    expect(commands.indexOf("apply_agent_workspace")).toBeLessThan(
      commands.indexOf("resume_agent_workspace"),
    );
    expect(candidate.get("pending.tex")).toBe("initial-pending.tex");
    expect(result.instructions).toContain(
      "Previously accepted portions are already applied",
    );
    expect(
      useDocumentStore.getState().restoreSourceWorkspace,
    ).toHaveBeenCalledWith(["pending.tex"], { preserveSelection: true });
  });

  it("keeps inline decisions retryable and does not launch refinement when their transaction fails", async () => {
    await openReview();
    useProposedChangesStore
      .getState()
      .setReviewedContent("a:pending.tex", "approved portion only");
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "apply_agent_workspace")
        throw new Error("Disk full during inline checkpoint");
      return original(command, args);
    });
    await expect(
      useAgentReviewQueueStore.getState().beginRefinement("a"),
    ).rejects.toThrow("Disk full during inline checkpoint");
    expect(invoke).not.toHaveBeenCalledWith(
      "resume_agent_workspace",
      expect.anything(),
    );
    expect(
      useProposedChangesStore.getState().getChangeForFile("pending.tex")
        ?.reviewedContent,
    ).toBe("approved portion only");
    expect(useAgentReviewQueueStore.getState().entries[0].phase).toBe("review");
    expect(useDocumentStore.getState().isAgentWorkspaceReadOnly).toBe(false);
  });

  it("keeps a paused draft when its explicit Continue fails to launch", async () => {
    const active = { ...session("a"), status: "active" as const };
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === "a"
          ? {
              ...tab,
              agentWorkspace: active,
              pauseState: "paused",
              sessionId: "thread",
              providerSessionIds: { codex: "thread" },
            }
          : tab,
      ),
    }));
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "inspect_paused_workspace")
        return { changed: false, revision: "unchanged", changes: [] };
      if (command === "resume_codex_code")
        throw new Error("Connection lost before launch");
      return original(command, args);
    });
    await useAgentChatStore.getState().sendPrompt("Continue", []);
    const tab = useAgentChatStore
      .getState()
      .tabs.find((tab) => tab.id === "a")!;
    expect(invoke).toHaveBeenCalledWith("resume_codex_code", expect.anything());
    expect(tab).toMatchObject({
      pauseState: "paused",
      isStreaming: false,
      agentWorkspace: active,
      error: "Connection lost before launch",
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "reconcile_agent_workspace",
      expect.anything(),
    );
    expect(useAgentReviewQueueStore.getState().entries).toEqual([]);
  });

  it("supports repeated rounds in the same slot while another agent waits", async () => {
    await openReview();
    for (let round = 1; round <= 3; round += 1) {
      const result = await useAgentReviewQueueStore
        .getState()
        .beginRefinement("a");
      expect(result.session.sessionId).toBe("a");
      expect(useDocumentStore.getState().agentWorkspaceSessionId).toBeNull();
      expect(
        useDocumentStore.getState().restoreSourceWorkspace,
      ).toHaveBeenCalled();
      expect(
        useAgentReviewQueueStore
          .getState()
          .entries.map((e) => [e.session.sessionId, e.phase]),
      ).toEqual([
        ["a", "revising"],
        ["b", "queued"],
      ]);
      candidate.set("pending.tex", `revision ${round}`);
      await useAgentReviewQueueStore.getState().enqueue(session("a"));
      expect(
        useAgentReviewQueueStore.getState().entries.map((e) => e.phase),
      ).toEqual(["review", "queued"]);
      expect(
        useAgentReviewQueueStore.getState().entries[0].refinementRound,
      ).toBe(round);
    }
    expect(invoke).not.toHaveBeenCalledWith(
      "preview_agent_workspace",
      expect.objectContaining({ sessionId: "b" }),
    );
    await useAgentReviewQueueStore.getState().finish("a");
    expect(useAgentReviewQueueStore.getState().entries[0]).toMatchObject({
      session: { sessionId: "b" },
      phase: "review",
    });
  });

  it("saves manual changes before resuming and retains approval of that user-edited version", async () => {
    await openReview();
    stageApproval("a:approved.tex");
    useDocumentStore.setState({
      files: files().map((file) =>
        file.id === "approved.tex"
          ? { ...file, content: "User wording", isDirty: true }
          : file,
      ),
    });
    const result = await useAgentReviewQueueStore
      .getState()
      .beginRefinement("a");
    expect(candidate.get("approved.tex")).toBe("User wording");
    const resumeCall = vi
      .mocked(invoke)
      .mock.calls.findIndex(([name]) => name === "resume_agent_workspace");
    expect(
      vi.mocked(writeTexFileContent).mock.invocationCallOrder.slice(-1)[0],
    ).toBeLessThan(vi.mocked(invoke).mock.invocationCallOrder[resumeCall]);
    expect(result.instructions).toContain('"decision":"approved"');
    candidate.set("pending.tex", "Refined fifth change");
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    expect(
      useProposedChangesStore.getState().workspaceReview?.decisions[
        "a:approved.tex"
      ],
    ).toEqual({ accept: true, content: "User wording" });
    expect(
      useDocumentStore
        .getState()
        .files.find((file) => file.id === "approved.tex")?.content,
    ).toBe("User wording");
  });

  it.each([
    "approved.tex",
    "approved.png",
  ])("invalidates only the changed approved version (%s)", async (path) => {
    await openReview();
    stageApproval("a:approved.tex");
    stageApproval("a:approved.png");
    await useAgentReviewQueueStore.getState().beginRefinement("a");
    candidate.set(path, "Agent changed this version");
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    const review = useProposedChangesStore.getState();
    const unchanged = path === "approved.tex" ? "approved.png" : "approved.tex";
    expect(review.workspaceReview?.decisions[`a:${path}`]).toBeUndefined();
    expect(review.workspaceReview?.decisions[`a:${unchanged}`]?.accept).toBe(
      true,
    );
    expect(review.changes.map((change) => change.filePath)).toContain(path);
    expect(review.changes.map((change) => change.filePath)).not.toContain(
      unchanged,
    );
  });

  it("keeps the draft review and does not resume when saving fails", async () => {
    await openReview();
    vi.mocked(writeTexFileContent).mockRejectedValueOnce(
      new Error("Disk full"),
    );
    await expect(
      useAgentReviewQueueStore.getState().beginRefinement("a"),
    ).rejects.toThrow("Disk full");
    expect(invoke).not.toHaveBeenCalledWith(
      "resume_agent_workspace",
      expect.anything(),
    );
    expect(
      useAgentReviewQueueStore.getState().entries.map((entry) => entry.phase),
    ).toEqual(["review", "queued"]);
    expect(useProposedChangesStore.getState().workspaceReview?.isApplying).toBe(
      false,
    );
    expect(useDocumentStore.getState().isAgentWorkspaceReadOnly).toBe(false);
  });

  it("returns to review after interrupted refinement without advancing the waiting draft", async () => {
    await openReview();
    await useAgentReviewQueueStore.getState().beginRefinement("a");
    await useAgentReviewQueueStore.getState().recoverRefinement("a");
    expect(
      useAgentReviewQueueStore.getState().entries.map((entry) => entry.phase),
    ).toEqual(["review", "queued"]);
    expect(useDocumentStore.getState().isAgentWorkspaceReadOnly).toBe(false);
    expect(
      useProposedChangesStore.getState().workspaceReview?.session.sessionId,
    ).toBe("a");
  });
});

describe("review feedback send integration", () => {
  it("launches feedback in the same sandbox without preparing another workspace", async () => {
    await openReview();
    const accepted = vi.fn();
    await useAgentChatStore
      .getState()
      .sendPrompt("Refine the fifth", undefined, false, accepted);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "execute_codex_code",
      expect.objectContaining({
        projectPath: "/a/candidate",
        sourceProjectPath: "/project",
        prompt: expect.stringContaining("Refine the fifth"),
      }),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "prepare_agent_workspace",
      expect.anything(),
    );
    expect(
      useAgentReviewQueueStore.getState().entries.map((e) => e.phase),
    ).toEqual(["revising", "queued"]);
  });

  it("does not consume feedback or add a user message when draft saving fails", async () => {
    await openReview();
    vi.mocked(writeTexFileContent).mockRejectedValueOnce(
      new Error("Disk full"),
    );
    const accepted = vi.fn();
    const before = useAgentChatStore.getState().tabs[0].messages;
    await useAgentChatStore
      .getState()
      .sendPrompt("Keep this feedback", undefined, false, accepted);
    expect(accepted).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().tabs[0].messages).toBe(before);
    expect(useAgentChatStore.getState().tabs[0].draft.input).toBe(
      "Refine the remaining change",
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "execute_codex_code",
      expect.anything(),
    );
    expect(useDocumentStore.getState().isAgentWorkspaceReadOnly).toBe(false);
  });

  it("serializes double sends during the asynchronous draft save", async () => {
    await openReview();
    let release!: () => void;
    const saving = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(writeTexFileContent).mockImplementationOnce(async () => saving);
    const accepted = vi.fn();
    const first = useAgentChatStore
      .getState()
      .sendPrompt("First feedback", undefined, false, accepted);
    const second = useAgentChatStore
      .getState()
      .sendPrompt("Duplicate feedback", undefined, false, accepted);
    release();
    await Promise.all([first, second]);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "resume_agent_workspace"),
    ).toHaveLength(1);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "execute_codex_code"),
    ).toHaveLength(1);
  });

  it("unlocks the same draft review when provider launch fails", async () => {
    await openReview();
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "execute_codex_code")
        throw new Error("Provider unavailable");
      return original(command, args);
    });
    await useAgentChatStore.getState().sendPrompt("Refine this");
    expect(
      useAgentReviewQueueStore.getState().entries.map((e) => e.phase),
    ).toEqual(["review", "queued"]);
    expect(useDocumentStore.getState().isAgentWorkspaceReadOnly).toBe(false);
    expect(
      useProposedChangesStore.getState().workspaceReview?.session.sessionId,
    ).toBe("a");
    expect(useAgentChatStore.getState().tabs[0].isStreaming).toBe(false);
    expect(useAgentChatStore.getState().tabs[0].error).toContain(
      "Provider unavailable",
    );
  });
});

it("preserves feedback and requires source reconciliation when native source check changes", async () => {
  await openReview();
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "preview_agent_workspace")
      return { ...preview("a"), sourceRevision: "changed-source" };
    return original(command, args);
  });
  const accepted = vi.fn();
  const before = useAgentChatStore.getState().tabs[0].messages;
  await useAgentChatStore
    .getState()
    .sendPrompt("Keep my refinement feedback", undefined, false, accepted);
  expect(accepted).not.toHaveBeenCalled();
  expect(useAgentChatStore.getState().tabs[0].messages).toBe(before);
  expect(useAgentChatStore.getState().tabs[0].draft.input).toBe(
    "Refine the remaining change",
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "resume_agent_workspace",
    expect.anything(),
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "execute_codex_code",
    expect.anything(),
  );
  expect(
    useAgentReviewQueueStore.getState().entries.map((entry) => entry.phase),
  ).toEqual(["question", "queued"]);
  expect(useDocumentStore.getState().isAgentWorkspaceReadOnly).toBe(true);
});

it("includes the latest rejected proposal snapshot when sending subsequent feedback", async () => {
  await openReview();
  for (const proposed of [
    "Earlier rejected wording",
    "Latest rejected wording",
  ]) {
    useAgentChatStore.getState()._appendMessage("a", {
      type: "system",
      subtype: "draft_review_decisions",
      message: {
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { path: "previous.tex", decision: "rejected", proposed },
            ]),
          },
        ],
      },
    });
  }
  await useAgentChatStore.getState().sendPrompt("Discuss the rejected wording");
  const call = vi
    .mocked(invoke)
    .mock.calls.find(([name]) => name === "execute_codex_code");
  expect(call).toBeDefined();
  expect(call?.[1]).toEqual(
    expect.objectContaining({
      prompt: expect.stringContaining("Latest rejected wording"),
    }),
  );
  expect(call?.[1]).toEqual(
    expect.objectContaining({
      prompt: expect.stringContaining("rejected proposals were not applied"),
    }),
  );
});
