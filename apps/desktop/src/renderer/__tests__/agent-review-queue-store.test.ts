import { retireAgentDraft } from "@/lib/retire-agent-draft";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import * as projectFiles from "@/lib/project-files";
import * as workspaceStorage from "@/lib/workspace-state-storage";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useHistoryStore } from "@/stores/history-store";
import { useDocumentStore } from "@/stores/document-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import type {
  AgentWorkspacePreview,
  AgentWorkspaceSession,
} from "@/lib/agent-workspace";

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
function preview(id: string, conflict = false): AgentWorkspacePreview {
  return {
    session: session(id),
    sourceRevision: `revision-${id}`,
    conflicts: conflict
      ? [
          {
            changeId: `${id}-change`,
            filePath: "main.tex",
            reason: "Overlapping edits",
          },
        ]
      : [],
    changes: [
      {
        id: `${id}-change`,
        kind: "modified",
        filePath: "main.tex",
        oldFilePath: "main.tex",
        newFilePath: "main.tex",
        oldContent: "old",
        newContent: id,
        sourceAbsolutePath: "/project/main.tex",
        candidateAbsolutePath: `/${id}/candidate/main.tex`,
        binary: false,
        sourceChanged: conflict,
      },
    ],
    currentContents: { [`${id}-change`]: "current" },
    mergedContents: { [`${id}-change`]: id },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useHistoryStore.setState({
    init: vi.fn(async () => {}),
    createSnapshot: vi.fn(async () => null),
  });
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
    activeTabId: "other",
    tabs: ["a", "b", "other"].map((id) => ({
      ...initial,
      id,
      isStreaming: false,
      agentWorkspace: id === "other" ? null : session(id),
    })),
    isStreaming: false,
  });
  useDocumentStore.setState({
    projectRoot: "/project",
    agentWorkspaceRoot: null,
    agentWorkspaceSessionId: null,
    sourceViewSnapshot: null,
    files: [],
    saveAllFiles: vi.fn(async () => {}),
    refreshFiles: vi.fn(async () => {}),
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
      });
    }),
    refreshSourceViewSnapshot: vi.fn(async () => {}),
    addAgentWorkspaceReviewFiles: vi.fn(async () => {}),
  });
  vi.mocked(invoke).mockImplementation(async (command, args: any) =>
    command === "preview_agent_workspace" ? preview(args.sessionId) : undefined,
  );
});

describe("agent draft queue", () => {
  it("interrupts a changed project without applying, discarding, or advancing the draft", async () => {
    const checked = { ...preview("a"), projectRevision: "before" };
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "preview_agent_workspace") return checked;
      if (command === "review_project_state")
        return { revision: "after", gitPending: false };
      if (command === "git_panel_status") return { repo_found: false };
    });
    const queue = useAgentReviewQueueStore.getState();
    await queue.enqueue(session("a"));
    useDocumentStore.setState({
      files: [
        {
          id: "main.tex",
          relativePath: "main.tex",
          name: "main.tex",
          absolutePath: "/a/candidate/main.tex",
          type: "tex",
          content: "manual proposal",
          isDirty: true,
        },
      ],
    });
    await queue.checkProject("a");
    let entry = useAgentReviewQueueStore.getState().entries[0];
    expect(entry).toMatchObject({
      phase: "question",
      interrupted: true,
      projectChangePending: true,
      editedContents: { "a-change": "manual proposal" },
    });
    expect(useProposedChangesStore.getState().workspaceReview).toBeNull();
    expect(useDocumentStore.getState().isAgentWorkspaceReadOnly).toBe(true);
    await queue.acknowledgeProjectChange("a");
    entry = useAgentReviewQueueStore.getState().entries[0];
    expect(entry.projectChangePending).toBe(false);
    expect(entry.phase).toBe("question");
    expect(useDocumentStore.getState().agentWorkspaceRoot).toBeNull();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) =>
          ["apply_agent_workspace", "discard_agent_workspace"].includes(
            command,
          ),
        ),
    ).toBe(false);
  });

  it("does not let a delayed project check interrupt a newer review", async () => {
    let complete!: (value: unknown) => void;
    const checked = { ...preview("a"), projectRevision: "before" };
    useAgentReviewQueueStore.setState({
      entries: [
        {
          session: session("a"),
          phase: "review",
          conflicts: [],
          preview: checked,
        },
      ],
    });
    vi.mocked(invoke).mockImplementation(
      async () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = useAgentReviewQueueStore.getState().checkProject("a");
    useAgentReviewQueueStore.setState({
      entries: [
        {
          session: session("a"),
          phase: "review",
          conflicts: [],
          preview: { ...checked, projectRevision: "new" },
        },
      ],
    });
    complete({ revision: "after", gitPending: false });
    expect(await pending).toBe(false);
    expect(
      useAgentReviewQueueStore.getState().entries[0].interrupted,
    ).toBeUndefined();
  });

  it("keeps an interrupted draft paused until Git finishes, then requires manual review in Edit mode", async () => {
    const saved = { ...session("a"), mode: "edit" as const };
    const checked = {
      ...preview("a"),
      session: saved,
      projectRevision: "after",
    };
    useAgentReviewQueueStore.setState({
      entries: [
        {
          session: saved,
          phase: "question",
          conflicts: [],
          interrupted: true,
          preview: checked,
        },
      ],
    });
    let gitPending = true;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "review_project_state")
        return { revision: "after", gitPending };
      if (command === "preview_agent_workspace") return checked;
    });
    await expect(
      useAgentReviewQueueStore.getState().recheck("a"),
    ).rejects.toThrow("Finish or abort");
    expect(useAgentReviewQueueStore.getState().entries[0].phase).toBe(
      "question",
    );
    gitPending = false;
    await useAgentReviewQueueStore.getState().recheck("a");
    expect(useAgentReviewQueueStore.getState().entries[0].phase).toBe("review");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "apply_agent_workspace"),
    ).toBe(false);
  });

  it("retains an unfinished draft and queue entry when disposal fails, then retries", async () => {
    const queue = useAgentReviewQueueStore.getState();
    await queue.enqueue(session("a"));
    await queue.enqueue(session("b"));
    useAgentReviewQueueStore.setState((state) => ({
      entries: state.entries.map((entry) =>
        entry.session.sessionId === "a"
          ? { ...entry, phase: "question" }
          : entry,
      ),
    }));
    useAgentChatStore.setState({ activeTabId: "a" });
    vi.mocked(invoke).mockImplementation(async (command, args: any) => {
      if (command === "discard_agent_workspace") throw new Error("Disk busy");
      if (command === "preview_agent_workspace") return preview(args.sessionId);
    });
    await expect(queue.answer("a", "Discard draft")).rejects.toThrow(
      "Disk busy",
    );
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === "a")
        ?.agentWorkspace?.sessionId,
    ).toBe("a");
    expect(
      useAgentReviewQueueStore.getState().entries.map((entry) => entry.phase),
    ).toEqual(["question", "queued"]);
    vi.mocked(invoke).mockImplementation(async (command, args: any) =>
      command === "preview_agent_workspace"
        ? preview(args.sessionId)
        : undefined,
    );
    await queue.answer("a", "Discard draft");
    expect(
      useAgentReviewQueueStore
        .getState()
        .entries.map((entry) => entry.session.sessionId),
    ).toEqual(["b"]);
    expect(useDocumentStore.getState().agentWorkspaceSessionId).toBe("b");
  });

  it("late retirement preserves a replacement draft and its review", async () => {
    let complete!: () => void;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "discard_agent_workspace")
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
    });
    const retirement = retireAgentDraft(session("a"));
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    const replacement = { ...session("b"), tabId: "a" };
    useAgentChatStore.getState()._setAgentWorkspace("a", replacement);
    useProposedChangesStore
      .getState()
      .startWorkspaceReview(replacement, preview("b").changes, "revision-b");
    const replacementReview =
      useProposedChangesStore.getState().workspaceReview;
    const replacementChanges = useProposedChangesStore.getState().changes;
    useDocumentStore.setState({
      projectRoot: "/other",
      agentWorkspaceSessionId: "b",
      agentWorkspaceRoot: "/b/candidate",
    });
    complete();
    await retirement;
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === "a")
        ?.agentWorkspace,
    ).toEqual(replacement);
    expect(useDocumentStore.getState().agentWorkspaceSessionId).toBe("b");
    expect(useProposedChangesStore.getState().workspaceReview).toBe(
      replacementReview,
    );
    expect(useProposedChangesStore.getState().changes).toEqual(
      replacementChanges,
    );
    expect(
      useProposedChangesStore.getState().workspaceReviewsByProject["/project"],
    ).toBe(replacementReview);
    expect(
      useDocumentStore.getState().restoreSourceWorkspace,
    ).not.toHaveBeenCalled();
  });

  it("does not delete a draft when restoring its source view fails", async () => {
    useDocumentStore.setState({
      agentWorkspaceSessionId: "a",
      agentWorkspaceRoot: "/a/candidate",
    });
    vi.mocked(
      useDocumentStore.getState().restoreSourceWorkspace,
    ).mockRejectedValueOnce(new Error("Source read failed"));
    await expect(retireAgentDraft(session("a"))).rejects.toThrow(
      "Source read failed",
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "discard_agent_workspace",
      expect.anything(),
    );
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === "a")
        ?.agentWorkspace?.sessionId,
    ).toBe("a");
  });

  it("restores the source before removing an empty refined sandbox and advancing", async () => {
    const queue = useAgentReviewQueueStore.getState();
    await queue.enqueue(session("a"));
    await queue.show("a");
    await queue.enqueue(session("b"));
    useAgentReviewQueueStore.setState((state) => ({
      entries: state.entries.map((entry) =>
        entry.session.sessionId === "a" ? { ...entry, phase: "queued" } : entry,
      ),
    }));
    const order: string[] = [];
    vi.mocked(invoke).mockImplementation(async (command, args: any) => {
      if (command === "discard_agent_workspace") {
        expect(useDocumentStore.getState().agentWorkspaceSessionId).toBeNull();
        expect(
          useProposedChangesStore.getState().workspaceReview?.session.sessionId,
        ).toBe("a");
        order.push("discard-a");
      }
      if (command === "preview_agent_workspace") {
        if (args.sessionId === "a") return { ...preview("a"), changes: [] };
        order.push("preview-b");
        return preview("b");
      }
      return undefined;
    });
    await queue.advance("/project");
    expect(order).toEqual(["discard-a", "preview-b"]);
    expect(
      useAgentReviewQueueStore
        .getState()
        .entries.map((entry) => entry.session.sessionId),
    ).toEqual(["b"]);
  });

  it("keeps B queued until A settles and checks B against the then-current source", async () => {
    const queue = useAgentReviewQueueStore.getState();
    await queue.enqueue(session("a"));
    await queue.enqueue(session("b"));
    expect(
      useAgentReviewQueueStore.getState().entries.map((entry) => entry.phase),
    ).toEqual(["review", "queued"]);
    expect(invoke).not.toHaveBeenCalledWith(
      "preview_agent_workspace",
      expect.objectContaining({ sessionId: "b" }),
    );
    vi.mocked(invoke).mockImplementation(async (command, args: any) =>
      command === "preview_agent_workspace"
        ? preview(args.sessionId, args.sessionId === "b")
        : undefined,
    );
    await queue.finish("a");
    expect(useAgentReviewQueueStore.getState().entries[0]).toMatchObject({
      session: { sessionId: "b" },
      phase: "question",
      conflicts: [{ filePath: "main.tex" }],
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
  });

  it("opens the project review independently of chat focus", async () => {
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    expect(
      useDocumentStore.getState().activateAgentWorkspace,
    ).toHaveBeenCalled();
    expect(
      useProposedChangesStore.getState().workspaceReview?.sourceRevision,
    ).toBe("revision-a");
    expect(useProposedChangesStore.getState().changes[0]).toMatchObject({
      oldContent: "current",
      newContent: "a",
    });
  });

  it.each([
    [true, false],
    [false, false],
    [true, true],
  ])("applies only an explicit file decision and keeps the remaining draft open (accept=%s, edit during reload=%s)", async (accept, lateEdit) => {
    const result = preview("a");
    const second = {
      ...result.changes[0],
      id: "second",
      filePath: "second.tex",
      oldFilePath: "second.tex",
      newFilePath: "second.tex",
      newContent: "My edited draft",
    };
    result.changes.push(second);
    const remaining = {
      ...result,
      sourceRevision: "after-partial-decision",
      changes: [second],
    };
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "preview_agent_workspace") return result;
      if (command === "apply_agent_workspace")
        return {
          applied: true,
          changedPaths: accept ? ["main.tex"] : [],
          conflicts: [],
          remainingPreview: remaining,
        };
    });
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    // The decided file was edited in the draft. So was the remaining one;
    // its edit is already part of the proposal the review shows.
    useDocumentStore.setState({
      files: [
        ["main.tex", "edited in review"],
        ["second.tex", "My edited draft"],
      ].map(([path, content]) => ({
        id: path,
        name: path,
        relativePath: path,
        absolutePath: `/a/candidate/${path}`,
        type: "tex" as const,
        content,
        isDirty: true,
      })),
    });
    vi.mocked(useDocumentStore.getState().refreshFiles).mockImplementation(
      async () => {
        const doc = useDocumentStore.getState();
        // The review controls stay disabled, and the editor read-only, while
        // the decision finishes.
        expect(
          useProposedChangesStore.getState().workspaceReview?.isApplying,
        ).toBe(true);
        // The reload sees the review of the remaining files only, and may
        // replace the decided file because it is no longer marked edited.
        expect(
          useProposedChangesStore
            .getState()
            .workspaceReview?.originalChanges.map((change) => change.id),
        ).toEqual(["second"]);
        expect(doc.files.map((file) => file.isDirty)).toEqual([false, true]);
        if (lateEdit)
          // An edit that arrives while the draft reloads, bypassing the lock.
          useDocumentStore.setState((state) => ({
            files: state.files.map((file) =>
              file.id === "second.tex"
                ? { ...file, content: "edited during the reload" }
                : file,
            ),
          }));
      },
    );
    if (accept) await useProposedChangesStore.getState().keepChange("a-change");
    else await useProposedChangesStore.getState().undoChange("a-change");
    // The draft stays open: no switch to the source view and back.
    expect(
      useDocumentStore.getState().refreshSourceViewSnapshot,
    ).toHaveBeenCalledExactlyOnceWith(accept ? ["main.tex"] : []);
    expect(
      useDocumentStore.getState().restoreSourceWorkspace,
    ).not.toHaveBeenCalled();
    expect(
      useDocumentStore.getState().activateAgentWorkspace,
    ).toHaveBeenCalledOnce();
    expect(useDocumentStore.getState().agentWorkspaceSessionId).toBe("a");
    expect(useDocumentStore.getState().refreshFiles).toHaveBeenCalledOnce();
    expect(useDocumentStore.getState().isAgentWorkspaceReadOnly).toBe(false);
    expect(useProposedChangesStore.getState().workspaceReview?.isApplying).toBe(
      false,
    );
    expect(
      useDocumentStore.getState().addAgentWorkspaceReviewFiles,
    ).toHaveBeenLastCalledWith([expect.objectContaining({ id: "second" })]);
    // The remaining file shows its proposal, unless it was edited meanwhile.
    expect(useDocumentStore.getState().files[1]).toMatchObject(
      lateEdit
        ? { content: "edited during the reload", isDirty: true }
        : { content: "My edited draft", isDirty: false },
    );
    expect(invoke).toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.objectContaining({
        decisions: [
          accept
            ? { changeId: "a-change", accept, content: "edited in review" }
            : { changeId: "a-change", accept },
        ],
        expectedSourceRevision: result.sourceRevision,
      }),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "discard_agent_workspace",
      expect.anything(),
    );
    expect(useAgentReviewQueueStore.getState().entries[0].phase).toBe("review");
    expect(useProposedChangesStore.getState().changes).toMatchObject([
      { id: "second" },
    ]);
    expect(
      useProposedChangesStore.getState().workspaceReview?.sourceRevision,
    ).toBe("after-partial-decision");
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === "a")
        ?.agentWorkspace?.sessionId,
    ).toBe("a");
  });

  it("switches to the source view and back when the saved source view cannot be refreshed", async () => {
    const result = preview("a");
    const second = {
      ...result.changes[0],
      id: "second",
      filePath: "second.tex",
    };
    result.changes.push(second);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "preview_agent_workspace") return result;
      if (command === "apply_agent_workspace")
        return {
          applied: true,
          changedPaths: ["main.tex"],
          conflicts: [],
          remainingPreview: { ...result, changes: [second] },
        };
    });
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    vi.mocked(
      useDocumentStore.getState().refreshSourceViewSnapshot,
    ).mockRejectedValue(new Error("unreadable"));
    await useProposedChangesStore.getState().keepChange("a-change");
    expect(
      useDocumentStore.getState().restoreSourceWorkspace,
    ).toHaveBeenCalledWith(["main.tex"], {
      preserveSelection: true,
      pendingReviewPaths: ["second.tex"],
    });
    expect(
      useDocumentStore.getState().activateAgentWorkspace,
    ).toHaveBeenCalledTimes(2);
    expect(useDocumentStore.getState().agentWorkspaceSessionId).toBe("a");
    expect(useProposedChangesStore.getState().changes).toMatchObject([
      { id: "second" },
    ]);
    expect(useAgentReviewQueueStore.getState().entries[0].phase).toBe("review");
    expect(useProposedChangesStore.getState().workspaceReview?.isApplying).toBe(
      false,
    );
  });

  it.each([
    "unchanged",
    "changed",
  ] as const)("saves text typed outside the review with the next file decision when the project is %s", async (project) => {
    const reviewed = { ...preview("a"), projectRevision: "project-1" };
    const second = {
      ...reviewed.changes[0],
      id: "second",
      filePath: "second.tex",
      oldFilePath: "second.tex",
      newFilePath: "second.tex",
    };
    reviewed.changes.push(second);
    const note = {
      ...reviewed.changes[0],
      id: "note",
      filePath: "notes.tex",
      oldFilePath: "notes.tex",
      newFilePath: "notes.tex",
      oldContent: "",
      newContent: "my note",
      proposalRevision: "note-1",
    };
    const write = vi
      .spyOn(projectFiles, "writeTexFileContent")
      .mockResolvedValue();
    try {
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === "review_project_state")
          return { revision: "project-1", gitPending: false };
        if (command === "preview_agent_workspace")
          // Once the note is in the draft, it is one more draft change.
          return write.mock.calls.length
            ? {
                ...reviewed,
                sourceRevision: "covers-the-note-too",
                projectRevision:
                  project === "changed" ? "project-2" : "project-1",
                changes: [...reviewed.changes, note],
              }
            : reviewed;
        if (command === "apply_agent_workspace")
          return {
            applied: true,
            changedPaths: ["main.tex", "notes.tex"],
            conflicts: [],
            remainingPreview: { ...reviewed, changes: [second] },
          };
      });
      await useAgentReviewQueueStore.getState().enqueue(session("a"));
      const draft = (path: string, content: string, isDirty: boolean) => ({
        id: path,
        name: path,
        relativePath: path,
        absolutePath: `/a/candidate/${path}`,
        type: "tex" as const,
        content,
        isDirty,
      });
      useDocumentStore.setState({
        files: [
          draft("main.tex", "a", false),
          draft("second.tex", "a", false),
          // Typed by the user in a file the agent did not touch.
          draft("notes.tex", "my note", true),
        ],
      });
      await useProposedChangesStore.getState().keepChange("a-change");
      expect(write).toHaveBeenCalledExactlyOnceWith(
        "/a/candidate/notes.tex",
        "my note",
      );
      const note_file = () =>
        useDocumentStore
          .getState()
          .files.find((file) => file.id === "notes.tex");
      if (project === "changed") {
        expect(invoke).not.toHaveBeenCalledWith(
          "apply_agent_workspace",
          expect.anything(),
        );
        expect(useAgentReviewQueueStore.getState().entries[0]).toMatchObject({
          phase: "question",
          error: expect.stringContaining("The source project changed"),
        });
        // The text is still in the editor for a retry.
        expect(note_file()).toMatchObject({
          content: "my note",
          isDirty: true,
        });
        return;
      }
      expect(invoke).toHaveBeenCalledWith(
        "apply_agent_workspace",
        expect.objectContaining({
          decisions: [
            { changeId: "a-change", accept: true, content: "a" },
            {
              changeId: "note",
              accept: true,
              proposalRevision: "note-1",
              content: "my note",
            },
          ],
          expectedSourceRevision: "covers-the-note-too",
          expectedProjectRevision: "project-1",
        }),
      );
      expect(
        useDocumentStore.getState().refreshSourceViewSnapshot,
      ).toHaveBeenCalledExactlyOnceWith(["main.tex", "notes.tex"]);
      // Saved, so the draft copy is no longer marked edited.
      expect(note_file()).toMatchObject({ content: "my note", isDirty: false });
      expect(useProposedChangesStore.getState().changes).toMatchObject([
        { id: "second" },
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it("returns to the source view after the last file decision", async () => {
    const result = preview("a");
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "preview_agent_workspace") return result;
      if (command === "apply_agent_workspace")
        return { applied: true, changedPaths: ["main.tex"], conflicts: [] };
    });
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    await useProposedChangesStore.getState().keepChange("a-change");
    expect(
      useDocumentStore.getState().refreshSourceViewSnapshot,
    ).not.toHaveBeenCalled();
    expect(
      useDocumentStore.getState().restoreSourceWorkspace,
    ).toHaveBeenCalledWith(["main.tex"], { preserveSelection: true });
    expect(useDocumentStore.getState().agentWorkspaceSessionId).toBeNull();
    expect(useAgentReviewQueueStore.getState().entries).toEqual([]);
  });

  it("rechecks safe-only choices and excludes newly conflicting files", async () => {
    const initial = preview("a", true);
    initial.changes.push({
      ...initial.changes[0],
      id: "safe",
      filePath: "safe.tex",
    });
    vi.mocked(invoke).mockResolvedValue(initial);
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    useAgentChatStore.setState({ activeTabId: "a" });
    const fresh = {
      ...initial,
      conflicts: [
        ...initial.conflicts,
        { changeId: "safe", filePath: "safe.tex", reason: "Changed again" },
      ],
    };
    vi.mocked(invoke).mockResolvedValue(fresh);
    await expect(
      useAgentReviewQueueStore.getState().answer("a", "Keep safe changes only"),
    ).rejects.toThrow("No safe changes");
    expect(useAgentReviewQueueStore.getState().entries[0].phase).toBe(
      "question",
    );
  });

  it("safe-only presents compatible changes without applying them", async () => {
    const mixed = preview("a", true);
    mixed.changes.push({
      ...mixed.changes[0],
      id: "safe",
      filePath: "safe.tex",
    });
    mixed.currentContents.safe = "safe before";
    mixed.mergedContents.safe = "safe after";
    vi.mocked(invoke).mockResolvedValue(mixed);
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    useAgentChatStore.setState({ activeTabId: "a" });
    await useAgentReviewQueueStore
      .getState()
      .answer("a", "Keep safe changes only");
    expect(
      useProposedChangesStore.getState().changes.map((change) => change.id),
    ).toEqual(["safe"]);
    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
  });

  it("discard releases the review slot without changing source", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args: any) =>
      command === "preview_agent_workspace"
        ? preview(args.sessionId, args.sessionId === "a")
        : undefined,
    );
    const queue = useAgentReviewQueueStore.getState();
    await queue.enqueue(session("a"));
    await queue.enqueue(session("b"));
    useAgentChatStore.setState({ activeTabId: "a" });
    await queue.answer("a", "Discard draft");
    expect(useAgentReviewQueueStore.getState().entries[0]).toMatchObject({
      session: { sessionId: "b" },
      phase: "review",
    });
    expect(invoke).toHaveBeenCalledWith("discard_agent_workspace", {
      projectRoot: "/project",
      sessionId: "a",
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
  });

  it("deduplicates repeated completions", async () => {
    const queue = useAgentReviewQueueStore.getState();
    await Promise.all([
      queue.enqueue(session("a")),
      queue.enqueue(session("a")),
    ]);
    expect(useAgentReviewQueueStore.getState().entries).toHaveLength(1);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) => cmd === "preview_agent_workspace"),
    ).toHaveLength(1);
  });

  it("retains a draft when source save fails", async () => {
    useDocumentStore.setState({
      saveAllFiles: vi.fn(async () => {
        throw new Error("unsaved source conflict");
      }),
    });
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    expect(useAgentReviewQueueStore.getState().entries[0]).toMatchObject({
      phase: "question",
      error: "Error: unsaved source conflict",
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "preview_agent_workspace",
      expect.anything(),
    );
  });
});

it("preserves manual review edits when rechecking a changed source", async () => {
  useAgentChatStore.setState({ activeTabId: "a" });
  await useAgentReviewQueueStore.getState().enqueue(session("a"));
  useDocumentStore.setState({
    files: [
      {
        id: "main.tex",
        name: "main.tex",
        relativePath: "main.tex",
        absolutePath: "/a/candidate/main.tex",
        type: "tex",
        content: "My manual resolution",
        isDirty: true,
      },
    ],
  });
  await useAgentReviewQueueStore.getState().recheck("a");
  expect(invoke).toHaveBeenLastCalledWith(
    "preview_agent_workspace",
    expect.objectContaining({
      decisions: [
        { changeId: "a-change", content: "My manual resolution", accept: true },
      ],
    }),
  );
});

it("does not treat skipping a conflict choice as permission to revise", async () => {
  vi.mocked(invoke).mockResolvedValue(preview("a", true));
  await useAgentReviewQueueStore.getState().enqueue(session("a"));
  useAgentChatStore.setState({ activeTabId: "a" });
  await expect(
    useAgentReviewQueueStore
      .getState()
      .answer("a", "Skip this question (no option selected)."),
  ).rejects.toThrow("Choose how");
  expect(useAgentReviewQueueStore.getState().entries[0].phase).toBe("question");
});

it("refreshes and refines the same worktree from a source-change question", async () => {
  vi.mocked(invoke).mockResolvedValue(preview("a", true));
  await useAgentReviewQueueStore.getState().enqueue(session("a"));
  useAgentChatStore.setState({ activeTabId: "a" });
  vi.mocked(invoke).mockResolvedValue(preview("a"));
  const originalSend = useAgentChatStore.getState().sendPrompt;
  const send = vi.fn(async () => {
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === "a")
        ?.agentWorkspace?.sessionId,
    ).toBe("a");
  });
  useAgentChatStore.setState({ sendPrompt: send });
  try {
    await useAgentReviewQueueStore.getState().answer("a", "Update draft");
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining("latest project"),
      undefined,
      false,
      undefined,
      "a",
    );
    expect(
      useAgentReviewQueueStore.getState().entries[0].session.sessionId,
    ).toBe("a");
    expect(invoke).not.toHaveBeenCalledWith(
      "discard_agent_workspace",
      expect.anything(),
    );
  } finally {
    useAgentChatStore.setState({ sendPrompt: originalSend });
  }
});

it("allows explicit refinement of non-text conflicts in the same worktree", async () => {
  const result = preview("a", true);
  result.changes[0] = {
    ...result.changes[0],
    binary: true,
    oldContent: null,
    newContent: null,
  };
  vi.mocked(invoke).mockResolvedValue(result);
  await useAgentReviewQueueStore.getState().enqueue(session("a"));
  useAgentChatStore.setState({ activeTabId: "a" });
  const original = useAgentChatStore.getState().sendPrompt;
  const send = vi.fn(async () => {});
  useAgentChatStore.setState({ sendPrompt: send });
  try {
    await useAgentReviewQueueStore.getState().answer("a", "Update draft");
    expect(send).toHaveBeenCalled();
    expect(
      useAgentReviewQueueStore.getState().entries[0].session.sessionId,
    ).toBe("a");
    expect(useDocumentStore.getState().agentWorkspaceSessionId).toBe("a");
    expect(invoke).not.toHaveBeenCalledWith(
      "discard_agent_workspace",
      expect.anything(),
    );
  } finally {
    useAgentChatStore.setState({ sendPrompt: original });
  }
});

it("retains the same draft when a refreshed refinement cannot launch", async () => {
  vi.mocked(invoke).mockResolvedValue(preview("a", true));
  await useAgentReviewQueueStore.getState().enqueue(session("a"));
  useAgentChatStore.setState({ activeTabId: "a" });
  vi.mocked(invoke).mockResolvedValue(preview("a"));
  const originalSend = useAgentChatStore.getState().sendPrompt;
  useAgentChatStore.setState({
    sendPrompt: vi.fn(async () => {
      throw new Error("Provider unavailable");
    }),
  });
  try {
    await expect(
      useAgentReviewQueueStore.getState().answer("a", "Update draft"),
    ).rejects.toThrow("Provider unavailable");
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === "a")
        ?.agentWorkspace?.sessionId,
    ).toBe("a");
    expect(useAgentReviewQueueStore.getState().entries[0].phase).toBe("review");
    expect(invoke).not.toHaveBeenCalledWith(
      "discard_agent_workspace",
      expect.anything(),
    );
  } finally {
    useAgentChatStore.setState({ sendPrompt: originalSend });
  }
});

describe("Edit mode automatic acceptance", () => {
  function mockApply(outcome: "success" | "conflict" | "error" = "success") {
    vi.mocked(invoke).mockImplementation(async (command, args: any) => {
      if (command === "preview_agent_workspace") return preview(args.sessionId);
      if (command === "apply_agent_workspace") {
        if (outcome === "error") throw new Error("Disk write failed");
        return {
          applied: outcome === "success",
          changedPaths: outcome === "success" ? ["main.tex"] : [],
          conflicts:
            outcome === "conflict"
              ? [
                  {
                    changeId: "a-change",
                    filePath: "main.tex",
                    reason: "Source changed",
                  },
                ]
              : [],
        };
      }
    });
  }

  it("retains the sandbox and releases the queue when recovery storage cannot save", async () => {
    mockApply();
    const flush = vi
      .spyOn(workspaceStorage, "flushWorkspaceState")
      .mockRejectedValueOnce(new Error("disk full"));
    try {
      await useAgentReviewQueueStore
        .getState()
        .enqueue({ ...session("a"), mode: "edit" });
      expect(invoke).not.toHaveBeenCalledWith(
        "apply_agent_workspace",
        expect.anything(),
      );
      expect(invoke).not.toHaveBeenCalledWith(
        "discard_agent_workspace",
        expect.anything(),
      );
      expect(useAgentReviewQueueStore.getState().entries[0]).toMatchObject({
        phase: "question",
      });
      // A fresh attempt can proceed after storage recovers; no stuck processing lock.
      await useAgentReviewQueueStore.getState().recheck("a");
      expect(invoke).toHaveBeenCalledWith(
        "apply_agent_workspace",
        expect.objectContaining({ sessionId: "a" }),
      );
    } finally {
      flush.mockRestore();
    }
  });

  it.each([
    "claude",
    "codex",
  ])("applies a clean %s Edit draft without ever publishing review UI", async (provider) => {
    mockApply();
    useAgentChatStore.setState({
      selectedProvider: provider as "claude" | "codex",
      selectedClaudeExecutionMode: "default",
      selectedCodexExecutionMode: "default",
    });
    const shown: number[] = [];
    const unsubscribe = useProposedChangesStore.subscribe((state) =>
      shown.push(state.changes.length),
    );
    await useAgentReviewQueueStore
      .getState()
      .enqueue({ ...session("a"), mode: "edit" });
    unsubscribe();
    expect(shown.every((count) => count === 0)).toBe(true);
    expect(
      useDocumentStore.getState().activateAgentWorkspace,
    ).not.toHaveBeenCalled();
    expect(useProposedChangesStore.getState().workspaceReview).toBeNull();
    expect(invoke).toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.objectContaining({
        sessionId: "a",
        expectedSourceRevision: "revision-a",
        decisions: [{ changeId: "a-change", accept: true, content: "a" }],
      }),
    );
    // The native apply records the only "after" checkpoint.
    expect(useHistoryStore.getState().createSnapshot).not.toHaveBeenCalled();
    expect(
      useDocumentStore.getState().restoreSourceWorkspace,
    ).toHaveBeenCalledWith(["main.tex"], { preserveSelection: true });
    expect(useAgentReviewQueueStore.getState().entries).toEqual([]);
  });

  it.each([
    "conflict",
    "error",
  ] as const)("pauses on apply %s without discarding or automatically retrying", async (outcome) => {
    mockApply(outcome);
    await useAgentReviewQueueStore
      .getState()
      .enqueue({ ...session("a"), mode: "edit" });
    expect(useAgentReviewQueueStore.getState().entries[0]).toMatchObject({
      phase: "question",
    });
    expect(useProposedChangesStore.getState().changes).toEqual([]);
    expect(invoke).not.toHaveBeenCalledWith(
      "discard_agent_workspace",
      expect.anything(),
    );
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "apply_agent_workspace"),
    ).toHaveLength(1);
    expect(useHistoryStore.getState().createSnapshot).not.toHaveBeenCalled();
  });

  it("does not apply overlapping changes or a failed Edit draft", async () => {
    vi.mocked(invoke).mockResolvedValue(preview("a", true));
    await useAgentReviewQueueStore
      .getState()
      .enqueue({ ...session("a"), mode: "edit" });
    expect(useAgentReviewQueueStore.getState().entries[0].phase).toBe(
      "question",
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
    useAgentReviewQueueStore.setState({ entries: [] });
    vi.mocked(invoke).mockResolvedValue(preview("a"));
    await useAgentReviewQueueStore
      .getState()
      .enqueue({ ...session("a"), mode: "edit", status: "failed" });
    expect(useAgentReviewQueueStore.getState().entries[0].phase).toBe(
      "question",
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
  });

  it("leaves Ask manual even if the current mode selector changes to Edit", async () => {
    mockApply();
    useAgentChatStore.setState({
      selectedClaudeExecutionMode: "edit",
      selectedCodexExecutionMode: "edit",
    });
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    await useAgentReviewQueueStore
      .getState()
      .enqueue({ ...session("b"), mode: "edit" });
    expect(
      useAgentReviewQueueStore.getState().entries.map((entry) => entry.phase),
    ).toEqual(["review", "queued"]);
    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
    await useProposedChangesStore.getState().keepAll();
    expect(useAgentReviewQueueStore.getState().entries).toEqual([]);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "apply_agent_workspace")
        .map(([, args]: any) => args.sessionId),
    ).toEqual(["a", "b"]);
  });
});

describe("three-way agent review", () => {
  function conflictedPreview() {
    const result = preview("a", true);
    result.changes[0].proposalRevision = "proposal-v1";
    result.conflictContents = {
      "a-change": [
        { kind: "resolved" as const, content: "User title\n" },
        {
          kind: "conflict" as const,
          ancestor: "10\n",
          current: "20\n",
          agent: "15\n",
        },
        { kind: "resolved" as const, content: "Agent conclusion\n" },
      ],
    };
    return result;
  }

  it("opens overlapping proposals in the existing review without applying them", async () => {
    const result = conflictedPreview();
    vi.mocked(invoke).mockResolvedValue(result);
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    expect(useAgentReviewQueueStore.getState().entries[0].phase).toBe("review");
    expect(
      useProposedChangesStore.getState().changes[0].conflictContents,
    ).toEqual(result.conflictContents?.["a-change"]);
    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
  });

  it("does not accept unresolved conflicts through bulk acceptance", async () => {
    vi.mocked(invoke).mockResolvedValue(conflictedPreview());
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    await useProposedChangesStore.getState().keepAll();
    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
    expect(useProposedChangesStore.getState().changes).toHaveLength(1);
  });

  it("binds an explicitly applied resolution to the source and proposal revisions", async () => {
    const result = conflictedPreview();
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "apply_agent_workspace"
        ? { applied: true, changedPaths: ["main.tex"], conflicts: [] }
        : result,
    );
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    const content = "User title\n10\nAgent conclusion\n";
    useProposedChangesStore.getState().resolveConflict("a-change", content);
    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
    useDocumentStore.setState({
      files: [
        {
          id: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/a/candidate/main.tex",
          name: "main.tex",
          type: "tex",
          content,
          isDirty: true,
        },
      ],
    });
    await useProposedChangesStore.getState().keepChange("a-change");
    expect(invoke).toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.objectContaining({
        expectedSourceRevision: "revision-a",
        decisions: [
          {
            changeId: "a-change",
            accept: true,
            content,
            resolvedConflict: true,
            proposalRevision: "proposal-v1",
          },
        ],
      }),
    );
  });

  it("invalidates a saved resolution when the current file or agent proposal changes", async () => {
    let result = conflictedPreview();
    vi.mocked(invoke).mockImplementation(async () => result);
    await useAgentReviewQueueStore.getState().enqueue(session("a"));
    useProposedChangesStore.getState().resolveConflict("a-change", "resolved");
    result = {
      ...conflictedPreview(),
      sourceRevision: "new-source",
      currentContents: { "a-change": "changed user content" },
    };
    useAgentReviewQueueStore.setState((state) => ({
      entries: state.entries.map((entry) => ({ ...entry, preview: result })),
    }));
    await useAgentReviewQueueStore.getState().show("a");
    const change = useProposedChangesStore.getState().changes[0];
    expect(change.resolvedConflict).not.toBe(true);
  });
});
