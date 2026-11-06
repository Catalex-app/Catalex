import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  PROPOSED_CHANGES_STORAGE_KEY,
  useProposedChangesStore,
} from "@/stores/proposed-changes-store";
import { useDocumentStore } from "@/stores/document-store";
import {
  applyAgentWorkspace,
  discardAgentWorkspace,
} from "@/lib/agent-workspace";

const workspaceMocks = vi.hoisted(() => ({
  settling: false,
  files: [] as {
    id: string;
    relativePath: string;
    absolutePath: string;
    content: string;
  }[],
  saveFile: vi.fn(async (_id: string) => {}),
  updateFileContent: vi.fn(),
  reloadFile: vi.fn(),
  restoreSourceWorkspace: vi.fn(() => Promise.resolve()),
  initHistory: vi.fn(() => Promise.resolve()),
  createSnapshot: vi.fn(() => Promise.resolve()),
  setAgentWorkspace: vi.fn(),
  setError: vi.fn(),
  appendMessage: vi.fn(async () => {}),
  syncSharedSession: vi.fn(async () => {}),
}));

// Mock the document store (used by keepChange/undoChange)
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({
      projectRoot: "/papers/review",
      files: workspaceMocks.files,
      saveFile: workspaceMocks.saveFile,
      updateFileContent: workspaceMocks.updateFileContent,
      saveAllFiles: vi.fn(() => Promise.resolve()),
      reloadFile: workspaceMocks.reloadFile,
      restoreSourceWorkspace: workspaceMocks.restoreSourceWorkspace,
    })),
  },
}));

vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({
      init: workspaceMocks.initHistory,
      createSnapshot: workspaceMocks.createSnapshot,
    })),
  },
}));

vi.mock("@/stores/agent-chat-store", () => ({
  useAgentChatStore: {
    getState: vi.fn(() => ({
      tabs: [
        { id: "tab-1", isSettling: workspaceMocks.settling },
        { id: "tab-review", agentWorkspace: { sessionId: "workspace-review" } },
      ],
      _setAgentWorkspace: workspaceMocks.setAgentWorkspace,
      _setError: workspaceMocks.setError,
      _recordReviewDecision: workspaceMocks.appendMessage,
      _syncSharedSession: workspaceMocks.syncSharedSession,
    })),
  },
}));

vi.mock("@/lib/agent-workspace", () => ({
  applyAgentWorkspace: vi.fn(),
  discardAgentWorkspace: vi.fn(),
}));

describe("useProposedChangesStore", () => {
  it("keeps bulk proposals when the first source file cannot be validated", async () => {
    for (const name of ["first", "second"])
      useProposedChangesStore.getState().addChange({
        id: name,
        filePath: `${name}.tex`,
        absolutePath: `/gone/${name}.tex`,
        oldContent: "old",
        newContent: "new",
        toolName: "Edit",
      });
    await useProposedChangesStore.getState().keepAll();
    expect(
      useProposedChangesStore.getState().changes.map((change) => change.id),
    ).toEqual(["first", "second"]);
    expect(workspaceMocks.saveFile).not.toHaveBeenCalled();
    expect(workspaceMocks.reloadFile).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    workspaceMocks.settling = false;
    workspaceMocks.files = [];
    workspaceMocks.saveFile.mockReset().mockResolvedValue(undefined);
    workspaceMocks.updateFileContent.mockReset();
    workspaceMocks.reloadFile.mockReset();
    vi.mocked(applyAgentWorkspace).mockReset();
    vi.mocked(discardAgentWorkspace).mockReset();
    workspaceMocks.restoreSourceWorkspace.mockClear();
    workspaceMocks.initHistory.mockClear();
    workspaceMocks.createSnapshot.mockClear();
    workspaceMocks.setAgentWorkspace.mockClear();
    workspaceMocks.setError.mockClear();
    workspaceMocks.appendMessage.mockClear();
    useProposedChangesStore.setState({
      changes: [],
      activeProjectRoot: null,
      changesByProject: {},
      workspaceReview: null,
      workspaceReviewsByProject: {},
    });
    localStorage.removeItem(PROPOSED_CHANGES_STORAGE_KEY);
  });

  describe("project persistence", () => {
    it("clears stale workspace review state without removing legacy proposals", () => {
      const store = useProposedChangesStore.getState();
      store.startWorkspaceReview(
        {
          version: 2,
          sessionId: "workspace-stale",
          projectRoot: "/papers/recovered",
          tabId: "tab-default",
          mode: "ask",
          status: "review",
          createdAt: 1,
          updatedAt: 1,
          sourceCommit: "fixture-source",
          baselineCommit: "fixture-baseline",
          candidateRoot: "/workspace/candidate",
          warnings: [],
        },
        [
          {
            id: "workspace-change",
            kind: "modified",
            filePath: "main.tex",
            oldFilePath: "main.tex",
            newFilePath: "main.tex",
            sourceAbsolutePath: "/papers/recovered/main.tex",
            candidateAbsolutePath: "/workspace/candidate/main.tex",
            oldContent: "old",
            newContent: "new",
            binary: false,
            sourceChanged: false,
          },
        ],
      );
      useProposedChangesStore.getState().addChange({
        id: "legacy-change",
        filePath: "notes.tex",
        absolutePath: "/papers/recovered/notes.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Edit",
      });

      useProposedChangesStore
        .getState()
        .clearWorkspaceReview("/papers/recovered");

      expect(useProposedChangesStore.getState().workspaceReview).toBeNull();
      expect(useProposedChangesStore.getState().changes).toEqual([
        expect.objectContaining({ id: "legacy-change" }),
      ]);
    });

    it("restores pending changes only for the project that created them", () => {
      const store = useProposedChangesStore.getState();
      store.activateProject("/papers/first/");
      useProposedChangesStore.getState().addChange({
        id: "tool-persisted",
        filePath: "main.tex",
        absolutePath: "/papers/first/main.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Edit",
      });

      useProposedChangesStore.getState().activateProject(null);
      expect(useProposedChangesStore.getState().changes).toEqual([]);

      useProposedChangesStore.getState().activateProject("/papers/second");
      expect(useProposedChangesStore.getState().changes).toEqual([]);

      useProposedChangesStore.getState().activateProject("/papers/first");
      expect(useProposedChangesStore.getState().changes).toEqual([
        expect.objectContaining({ id: "tool-persisted" }),
      ]);
    });

    it("rehydrates pending changes after an app restart", async () => {
      useProposedChangesStore
        .getState()
        .activateProject("C:\\papers\\restart-test\\");
      useProposedChangesStore.getState().addChange({
        id: "tool-after-restart",
        filePath: "main.tex",
        absolutePath: "C:\\papers\\restart-test\\main.tex",
        oldContent: "before restart",
        newContent: "after restart",
        toolName: "CodexEdit",
      });
      const persisted = localStorage.getItem(PROPOSED_CHANGES_STORAGE_KEY);
      expect(persisted).not.toBeNull();

      useProposedChangesStore.setState({
        changes: [],
        activeProjectRoot: null,
        changesByProject: {},
      });
      localStorage.setItem(PROPOSED_CHANGES_STORAGE_KEY, persisted ?? "");
      await useProposedChangesStore.persist.rehydrate();

      useProposedChangesStore
        .getState()
        .activateProject("C:/papers/restart-test");
      expect(useProposedChangesStore.getState().changes).toEqual([
        expect.objectContaining({
          id: "tool-after-restart",
          oldContent: "before restart",
          newContent: "after restart",
        }),
      ]);
    });

    it("removes a resolved change from persisted project state", () => {
      useProposedChangesStore.getState().activateProject("/papers/resolved");
      useProposedChangesStore.getState().addChange({
        id: "tool-resolved",
        filePath: "main.tex",
        absolutePath: "/papers/resolved/main.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Edit",
      });

      useProposedChangesStore.getState().resolveChange("tool-resolved");
      useProposedChangesStore.getState().activateProject(null);
      useProposedChangesStore.getState().activateProject("/papers/resolved");

      expect(useProposedChangesStore.getState().changes).toEqual([]);
      expect(
        useProposedChangesStore.getState().changesByProject,
      ).not.toHaveProperty("/papers/resolved");
    });
  });

  describe("isolated workspace settlement", () => {
    function startReview() {
      useProposedChangesStore.getState().activateProject("/papers/review");
      useProposedChangesStore.getState().startWorkspaceReview(
        {
          version: 2,
          sessionId: "workspace-review",
          projectRoot: "/papers/review",
          tabId: "tab-review",
          mode: "ask",
          status: "review",
          createdAt: 1,
          updatedAt: 1,
          sourceCommit: "fixture-source",
          baselineCommit: "fixture-baseline",
          candidateRoot: "/workspace/candidate",
          warnings: [],
        },
        [
          {
            id: "workspace-change",
            kind: "modified",
            filePath: "main.tex",
            oldFilePath: "main.tex",
            newFilePath: "main.tex",
            sourceAbsolutePath: "/papers/review/main.tex",
            candidateAbsolutePath: "/workspace/candidate/main.tex",
            oldContent: "old",
            newContent: "new",
            binary: false,
            sourceChanged: false,
          },
        ],
      );
    }

    it("does not apply a draft while its chat is being archived", async () => {
      startReview();
      const state = useProposedChangesStore.getState();
      state.workspaceReview!.session.tabId = "tab-1";
      workspaceMocks.settling = true;
      await state.keepChange("workspace-change");
      expect(applyAgentWorkspace).not.toHaveBeenCalled();
      expect(discardAgentWorkspace).not.toHaveBeenCalled();
    });

    it("reserves a review transaction before another window can remove a second decision", async () => {
      startReview();
      const state = useProposedChangesStore.getState();
      const first = state.changes[0];
      const second = { ...first, id: "second", filePath: "second.tex" };
      useProposedChangesStore.setState({
        changes: [first, second],
        workspaceReview: {
          ...state.workspaceReview!,
          originalChanges: [first, second],
        },
      });
      let release!: (
        result: Awaited<ReturnType<typeof applyAgentWorkspace>>,
      ) => void;
      vi.mocked(applyAgentWorkspace).mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const accepting = state.keepChange(first.id);
      // This arrives before the first transaction resumes its dynamic imports.
      await state.undoChange(second.id);
      await vi.waitFor(() =>
        expect(applyAgentWorkspace).toHaveBeenCalledTimes(1),
      );
      expect(
        useProposedChangesStore.getState().changes.map((change) => change.id),
      ).toEqual(["second"]);
      expect(vi.mocked(applyAgentWorkspace).mock.calls[0][2]).toEqual([
        expect.objectContaining({ changeId: first.id, accept: true }),
      ]);
      release({
        applied: false,
        changedPaths: [],
        conflicts: [
          {
            changeId: first.id,
            filePath: first.filePath,
            reason: "Test conflict",
          },
        ],
      });
      await accepting;
      expect(useProposedChangesStore.getState().changes).toHaveLength(2);
      vi.mocked(applyAgentWorkspace).mockResolvedValue({
        applied: false,
        changedPaths: [],
        conflicts: [],
      });
      await useProposedChangesStore.getState().undoChange(second.id);
      expect(applyAgentWorkspace).toHaveBeenCalledTimes(2);
    });

    it.each([
      "keepChange",
      "keepAll",
    ] as const)("%s accepts binary bytes without a text override", async (action) => {
      startReview();
      const session =
        useProposedChangesStore.getState().workspaceReview!.session;
      useProposedChangesStore.getState().startWorkspaceReview(session, [
        {
          id: "binary",
          kind: "added",
          filePath: "figure.png",
          oldFilePath: null,
          newFilePath: "figure.png",
          sourceAbsolutePath: "/papers/review/figure.png",
          candidateAbsolutePath: "/workspace/candidate/figure.png",
          oldContent: null,
          newContent: null,
          binary: true,
          sourceChanged: false,
        },
      ]);
      const doc = useDocumentStore.getState();
      vi.mocked(useDocumentStore.getState).mockReturnValueOnce({
        ...doc,
        files: [{ relativePath: "figure.png", content: "stale editor text" }],
      } as any);
      vi.mocked(applyAgentWorkspace).mockResolvedValue({
        applied: true,
        changedPaths: ["figure.png"],
        conflicts: [],
      });
      vi.mocked(discardAgentWorkspace).mockResolvedValue(undefined);
      if (action === "keepChange")
        await useProposedChangesStore.getState().keepChange("binary");
      else await useProposedChangesStore.getState().keepAll();
      expect(applyAgentWorkspace).toHaveBeenCalledWith(
        "/papers/review",
        session.sessionId,
        [{ changeId: "binary", accept: true }],
        undefined,
        undefined,
      );
    });

    it("settles an applied draft even when workspace cleanup fails", async () => {
      vi.mocked(applyAgentWorkspace).mockResolvedValue({
        applied: true,
        changedPaths: ["main.tex"],
        conflicts: [],
      });
      vi.mocked(discardAgentWorkspace).mockRejectedValue(
        new Error("cleanup unavailable"),
      );
      startReview();

      await useProposedChangesStore.getState().keepChange("workspace-change");

      expect(workspaceMocks.initHistory).toHaveBeenCalledWith("/papers/review");
      expect(
        workspaceMocks.initHistory.mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(applyAgentWorkspace).mock.invocationCallOrder[0],
      );
      expect(workspaceMocks.restoreSourceWorkspace).toHaveBeenCalledWith(
        ["main.tex"],
        { preserveSelection: true },
      );
      expect(workspaceMocks.setAgentWorkspace).toHaveBeenCalledWith(
        "tab-review",
        null,
      );
      expect(useProposedChangesStore.getState().changes).toEqual([]);
      expect(useProposedChangesStore.getState().workspaceReview).toBeNull();
      expect(workspaceMocks.setError).toHaveBeenCalledWith(
        "tab-review",
        expect.stringContaining("source was updated"),
      );
    });

    it("rejects a draft by restoring the source view without recording history", async () => {
      vi.mocked(applyAgentWorkspace).mockResolvedValue({
        applied: true,
        changedPaths: [],
        conflicts: [],
      });
      vi.mocked(discardAgentWorkspace).mockResolvedValue(undefined);
      startReview();

      await useProposedChangesStore.getState().undoChange("workspace-change");

      expect(applyAgentWorkspace).toHaveBeenCalledWith(
        "/papers/review",
        "workspace-review",
        [{ changeId: "workspace-change", accept: false }],
        undefined,
        undefined,
      );
      expect(workspaceMocks.initHistory).not.toHaveBeenCalled();
      expect(workspaceMocks.restoreSourceWorkspace).toHaveBeenCalledWith([], {
        preserveSelection: true,
      });
      expect(workspaceMocks.createSnapshot).not.toHaveBeenCalled();
      expect(workspaceMocks.setError).not.toHaveBeenCalled();
      expect(useProposedChangesStore.getState().changes).toEqual([]);
      expect(useProposedChangesStore.getState().workspaceReview).toBeNull();
    });

    it("does not claim source was updated when rejected-draft cleanup fails", async () => {
      vi.mocked(applyAgentWorkspace).mockResolvedValue({
        applied: true,
        changedPaths: [],
        conflicts: [],
      });
      vi.mocked(discardAgentWorkspace).mockRejectedValue(
        new Error("cleanup unavailable"),
      );
      startReview();

      await useProposedChangesStore.getState().undoChange("workspace-change");

      expect(workspaceMocks.setError).toHaveBeenCalledWith(
        "tab-review",
        expect.stringContaining("without changing source files"),
      );
      expect(workspaceMocks.setError).not.toHaveBeenCalledWith(
        "tab-review",
        expect.stringContaining("source was updated"),
      );
    });

    it("restores review decisions when the transactional apply conflicts", async () => {
      vi.mocked(applyAgentWorkspace).mockResolvedValue({
        applied: false,
        changedPaths: [],
        conflicts: [
          {
            changeId: "workspace-change",
            filePath: "main.tex",
            reason: "overlapping edits",
          },
        ],
      });
      startReview();

      await useProposedChangesStore.getState().keepChange("workspace-change");

      expect(useProposedChangesStore.getState().changes).toEqual([
        expect.objectContaining({ id: "workspace-change" }),
      ]);
      expect(useProposedChangesStore.getState().workspaceReview).not.toBeNull();
      expect(workspaceMocks.restoreSourceWorkspace).not.toHaveBeenCalled();
    });
  });

  describe("addChange", () => {
    it("adds a new change", () => {
      useProposedChangesStore.getState().addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Edit",
      });
      const { changes } = useProposedChangesStore.getState();
      expect(changes).toHaveLength(1);
      expect(changes[0].id).toBe("tool-1");
      expect(changes[0].oldContent).toBe("old");
      expect(changes[0].newContent).toBe("new");
      expect(changes[0].timestamp).toBeGreaterThan(0);
    });

    it("merges changes for the same file, preserving original oldContent", () => {
      const store = useProposedChangesStore.getState();
      store.addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "original",
        newContent: "first-edit",
        toolName: "Edit",
      });
      store.addChange({
        id: "tool-2",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "first-edit",
        newContent: "second-edit",
        toolName: "Edit",
      });
      const { changes } = useProposedChangesStore.getState();
      expect(changes).toHaveLength(1);
      expect(changes[0].id).toBe("tool-2");
      expect(changes[0].oldContent).toBe("original"); // preserved baseline
      expect(changes[0].newContent).toBe("second-edit");
    });

    it("keeps changes for different files separate", () => {
      const store = useProposedChangesStore.getState();
      store.addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "a",
        newContent: "b",
        toolName: "Edit",
      });
      store.addChange({
        id: "tool-2",
        filePath: "refs.bib",
        absolutePath: "/project/refs.bib",
        oldContent: "c",
        newContent: "d",
        toolName: "Write",
      });
      expect(useProposedChangesStore.getState().changes).toHaveLength(2);
    });
  });

  describe("resolveChange", () => {
    it("removes a change by id", () => {
      useProposedChangesStore.getState().addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "a",
        newContent: "b",
        toolName: "Edit",
      });
      useProposedChangesStore.getState().resolveChange("tool-1");
      expect(useProposedChangesStore.getState().changes).toHaveLength(0);
    });
  });

  describe("resolveChangesForFiles", () => {
    it("removes only changes for committed files", () => {
      const store = useProposedChangesStore.getState();
      store.addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "a",
        newContent: "b",
        toolName: "Edit",
      });
      store.addChange({
        id: "tool-2",
        filePath: "sections/intro.tex",
        absolutePath: "/project/sections/intro.tex",
        oldContent: "c",
        newContent: "d",
        toolName: "Edit",
      });

      store.resolveChangesForFiles(["main.tex"]);

      expect(useProposedChangesStore.getState().changes).toEqual([
        expect.objectContaining({ id: "tool-2" }),
      ]);
    });

    it("matches committed paths with normalized separators", () => {
      const store = useProposedChangesStore.getState();
      store.addChange({
        id: "tool-1",
        filePath: "sections/intro.tex",
        absolutePath: "/project/sections/intro.tex",
        oldContent: "a",
        newContent: "b",
        toolName: "Edit",
      });

      store.resolveChangesForFiles(["sections\\intro.tex"]);

      expect(useProposedChangesStore.getState().changes).toHaveLength(0);
    });
  });

  describe("undoChange", () => {
    beforeEach(() => {
      workspaceMocks.files = ["main.tex", "refs.bib"].map((path) => ({
        id: path,
        relativePath: path,
        absolutePath: `/project/${path}`,
        content: "new",
      }));
    });
    it("clears the pending change before async disk restore finishes", async () => {
      let resolveWrite: (() => void) | undefined;
      workspaceMocks.saveFile.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
      );

      useProposedChangesStore.getState().addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Edit",
      });

      const undoPromise = useProposedChangesStore
        .getState()
        .undoChange("tool-1");

      expect(useProposedChangesStore.getState().changes).toHaveLength(0);
      expect(workspaceMocks.updateFileContent).toHaveBeenCalledWith(
        "main.tex",
        "old",
      );
      expect(workspaceMocks.saveFile).toHaveBeenCalledWith("main.tex");

      resolveWrite?.();
      await undoPromise;
      expect(workspaceMocks.reloadFile).not.toHaveBeenCalled();
    });

    it("preserves edits made while an accepted source save is pending", async () => {
      let release!: () => void;
      workspaceMocks.saveFile.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      useProposedChangesStore.getState().addChange({
        id: "accepted",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Edit",
      });
      const saving = useProposedChangesStore.getState().keepChange("accepted");
      workspaceMocks.files[0].content = "newer typing";
      release();
      await saving;
      expect(workspaceMocks.saveFile).toHaveBeenCalledWith("main.tex");
      expect(workspaceMocks.reloadFile).not.toHaveBeenCalled();
      expect(workspaceMocks.updateFileContent).not.toHaveBeenCalled();
      expect(workspaceMocks.files[0].content).toBe("newer typing");
    });

    it("rejects a source write whose path now belongs to a different workspace", async () => {
      workspaceMocks.files[0].absolutePath = "/draft/main.tex";
      useProposedChangesStore.getState().addChange({
        id: "moved",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Edit",
      });
      await expect(
        useProposedChangesStore.getState().undoChange("moved"),
      ).rejects.toThrow("Reopen the source file");
      expect(workspaceMocks.updateFileContent).not.toHaveBeenCalled();
      expect(workspaceMocks.saveFile).not.toHaveBeenCalled();
      expect(
        useProposedChangesStore.getState().changes.map((c) => c.id),
      ).toEqual(["moved"]);
    });

    it("settles each rejection before its write and retains unattempted proposals", async () => {
      let resolveFirstWrite: (() => void) | undefined;
      workspaceMocks.saveFile
        .mockReturnValueOnce(
          new Promise<void>((resolve) => {
            resolveFirstWrite = resolve;
          }),
        )
        .mockResolvedValueOnce(undefined);

      useProposedChangesStore.getState().addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Edit",
      });
      useProposedChangesStore.getState().addChange({
        id: "tool-2",
        filePath: "refs.bib",
        absolutePath: "/project/refs.bib",
        oldContent: "old bib",
        newContent: "new bib",
        toolName: "Edit",
      });

      const undoPromise = useProposedChangesStore.getState().undoAll();

      expect(
        useProposedChangesStore.getState().changes.map((c) => c.id),
      ).toEqual(["tool-2"]);

      resolveFirstWrite?.();
      await undoPromise;
      expect(useProposedChangesStore.getState().changes).toHaveLength(0);
    });

    it("retains later proposals when bulk rejection cannot save the first file", async () => {
      for (const [id, filePath] of [
        ["first", "main.tex"],
        ["later", "refs.bib"],
      ])
        useProposedChangesStore.getState().addChange({
          id,
          filePath,
          absolutePath: `/project/${filePath}`,
          oldContent: "old",
          newContent: "new",
          toolName: "Edit",
        });
      workspaceMocks.saveFile.mockRejectedValueOnce(new Error("disk full"));
      await expect(
        useProposedChangesStore.getState().undoAll(),
      ).rejects.toThrow("disk full");
      expect(workspaceMocks.saveFile).toHaveBeenCalledTimes(1);
      expect(workspaceMocks.updateFileContent).toHaveBeenCalledWith(
        "main.tex",
        "old",
      );
      expect(
        useProposedChangesStore.getState().changes.map((c) => c.id),
      ).toEqual(["later"]);
    });
  });

  describe("getChangeForFile", () => {
    it("returns the change for a given file path", () => {
      useProposedChangesStore.getState().addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "a",
        newContent: "b",
        toolName: "Edit",
      });
      const change = useProposedChangesStore
        .getState()
        .getChangeForFile("main.tex");
      expect(change).toBeDefined();
      expect(change!.id).toBe("tool-1");
    });

    it("returns undefined for unknown file", () => {
      const change = useProposedChangesStore
        .getState()
        .getChangeForFile("nonexistent.tex");
      expect(change).toBeUndefined();
    });
  });
});
