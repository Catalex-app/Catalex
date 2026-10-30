import { invoke } from "@/lib/desktop/core";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import { rename, writeTextFile } from "@/lib/desktop/fs";
import * as fsLib from "@/lib/project-files";
import {
  useDocumentStore,
  getCurrentPdfBytes,
  clearPdfBytesCache,
  resolveTexRoot,
  type ProjectFile,
} from "@/stores/document-store";

const historyMock = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  loadSnapshots: vi.fn(async () => {}),
  createSnapshot: vi.fn(async (_root: string, _message: string) => {}),
}));

// Mock history store
vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => historyMock),
  },
}));

// Mock agent-chat-store
vi.mock("@/stores/agent-chat-store", () => ({
  useAgentChatStore: {
    getState: vi.fn(() => ({
      newSession: vi.fn(),
      restoreProjectTabs: vi.fn(),
    })),
  },
}));

// These tests cover file selection and editing; chat shutdown is tested separately.
vi.mock("@/lib/project-chat-lifecycle", () => ({
  prepareProjectExit: vi.fn(async () => {}),
  restoreProjectChats: vi.fn(),
}));

vi.mock("@/lib/mupdf/pdf-doc-cache", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/mupdf/pdf-doc-cache")>();
  return {
    ...actual,
    prepareForNewPdfRevision: vi.fn(),
  };
});

function makeFile(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    id: "main.tex",
    name: "main.tex",
    relativePath: "main.tex",
    absolutePath: "/project/main.tex",
    type: "tex",
    content: "Hello World",
    isDirty: false,
    ...overrides,
  };
}

describe("useDocumentStore", () => {
  it("exposes deleted assets and scanner-hidden binaries as whole-file review entries", async () => {
    useDocumentStore.setState({
      projectRoot: "/project",
      agentWorkspaceRoot: "/draft",
      agentWorkspaceSessionId: "draft",
      files: [],
      folders: [],
      activeFileId: "",
      openFileIds: [],
    });
    await useDocumentStore.getState().addAgentWorkspaceReviewFiles([
      {
        filePath: "figures/removed.png",
        kind: "deleted",
        oldContent: null,
        newContent: null,
        binary: true,
        sourceAbsolutePath: "/project/figures/removed.png",
        candidateAbsolutePath: null,
      },
      {
        filePath: "outputs/archive.zip",
        kind: "added",
        oldContent: null,
        newContent: null,
        binary: true,
        sourceAbsolutePath: "/project/outputs/archive.zip",
        candidateAbsolutePath: "/draft/outputs/archive.zip",
      },
    ]);
    expect(useDocumentStore.getState().files).toEqual([
      expect.objectContaining({
        relativePath: "figures/removed.png",
        type: "image",
        isBinary: true,
        absolutePath: "/draft/figures/removed.png",
      }),
      expect.objectContaining({
        relativePath: "outputs/archive.zip",
        type: "other",
        isBinary: true,
        absolutePath: "/draft/outputs/archive.zip",
      }),
    ]);
    expect(
      useDocumentStore
        .getState()
        .files.every((file) => file.content === undefined),
    ).toBe(true);
    expect(useDocumentStore.getState().folders).toEqual(["figures", "outputs"]);
  });

  it.each([
    "file",
    "folder",
  ])("preserves editor state when moving a %s to Trash fails", async (kind) => {
    const file = makeFile({
      id: "draft/note.tex",
      relativePath: "draft/note.tex",
      absolutePath: "/project/draft/note.tex",
      content: "saved",
      isDirty: false,
    });
    useDocumentStore.setState({
      files: [makeFile(), file],
      activeFileId: file.id,
      openFileIds: [file.id],
    });
    const before = useDocumentStore.getState();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Trash unavailable"));
    if (kind === "file") await useDocumentStore.getState().deleteFile(file.id);
    else await useDocumentStore.getState().deleteFolder("draft");
    expect(useDocumentStore.getState().files).toBe(before.files);
    expect(useDocumentStore.getState().openFileIds).toBe(before.openFileIds);
    expect(useDocumentStore.getState().activeFileId).toBe(file.id);
  });

  describe.each(["file", "folder"])("%s deletion checkpoints", (kind) => {
    const remove = () =>
      kind === "file"
        ? useDocumentStore.getState().deleteFile("draft/note.tex")
        : useDocumentStore.getState().deleteFolder("draft");

    beforeEach(() => {
      vi.mocked(writeTextFile).mockReset().mockResolvedValue(undefined);
      vi.mocked(invoke).mockClear();
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: "draft/note.tex",
            relativePath: "draft/note.tex",
            absolutePath: "/project/draft/note.tex",
            content: "latest draft",
            isDirty: true,
          }),
        ],
        folders: ["draft"],
      });
    });

    it("saves pending edits and checkpoints before moving to Trash", async () => {
      const order: string[] = [];
      vi.mocked(writeTextFile).mockImplementation(async () => {
        order.push("save");
      });
      historyMock.createSnapshot.mockImplementation(async () => {
        order.push("checkpoint");
        expect(invoke).not.toHaveBeenCalledWith(
          "desktop:shell:trash",
          expect.anything(),
        );
      });
      await remove();
      expect(order).toEqual(["save", "checkpoint"]);
      expect(writeTextFile).toHaveBeenCalledWith(
        "/project/draft/note.tex",
        "latest draft",
      );
      expect(invoke).toHaveBeenCalledWith("desktop:shell:trash", {
        path: kind === "file" ? "/project/draft/note.tex" : "/project/draft",
      });
      expect(useDocumentStore.getState().files.map((f) => f.id)).toEqual([
        "main.tex",
      ]);
    });

    it.each([
      "save",
      "checkpoint",
    ])("cancels deletion if %s fails", async (stage) => {
      if (stage === "save")
        vi.mocked(writeTextFile).mockRejectedValueOnce(new Error("Disk full"));
      else
        historyMock.createSnapshot.mockRejectedValueOnce(
          new Error("History unavailable"),
        );
      await remove();
      expect(invoke).not.toHaveBeenCalledWith(
        "desktop:shell:trash",
        expect.anything(),
      );
      expect(
        useDocumentStore.getState().files.find((f) => f.id === "draft/note.tex")
          ?.content,
      ).toBe("latest draft");
    });

    it("cancels deletion when edits arrive during the checkpoint", async () => {
      historyMock.createSnapshot.mockImplementation(async () => {
        useDocumentStore.setState((state) => ({
          files: state.files.map((file) =>
            file.id === "draft/note.tex"
              ? { ...file, content: "new edit", isDirty: true }
              : file,
          ),
        }));
      });
      await remove();
      expect(invoke).not.toHaveBeenCalledWith(
        "desktop:shell:trash",
        expect.anything(),
      );
      expect(useDocumentStore.getState().files[1].content).toBe("new edit");
    });
  });

  beforeEach(() => {
    clearPdfBytesCache();
    historyMock.init.mockReset().mockResolvedValue(undefined);
    historyMock.createSnapshot.mockReset().mockResolvedValue(undefined);
    vi.mocked(writeTextFile).mockClear();
    // The guarded backend command replaces the raw write. Keep the existing
    // slow-write/error fixtures at the I/O boundary for ordering tests.
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "save_file_if_unchanged") return undefined;
      const save = args as {
        projectRoot: string;
        filePath: string;
        content: string;
      };
      await writeTextFile(`${save.projectRoot}/${save.filePath}`, save.content);
      return { written: true, current: save.content };
    });
    useDocumentStore.setState({
      projectRoot: "/project",
      agentWorkspaceSessionId: null,
      agentWorkspaceRoot: null,
      isAgentWorkspaceReadOnly: false,
      sourceViewSnapshot: null,
      files: [makeFile()],
      folders: [],
      activeFileId: "main.tex",
      cursorPosition: 5, // after "Hello"
      selectionRange: null,
      jumpToPosition: null,
      isThreadOpen: false,
      pdfRevision: 0,
      compileError: null,
      compileErrorCache: new Map(),
      compileDiagnosticsCache: new Map(),
      isCompiling: false,
      pendingRecompile: false,
      isSaving: false,
      isGitOperationRunning: false,
      initialized: true,
    });
  });

  describe("file reload races", () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
      "typing",
      "project switch",
      "reopen",
    ])("discards a delayed read after %s", async (change) => {
      let finish!: (text: string) => void;
      vi.spyOn(fsLib, "readTexFileContent").mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      );
      const loading = useDocumentStore.getState().reloadFile("main.tex");
      const replacement = makeFile({ content: "newer writing", isDirty: true });
      useDocumentStore.setState({
        ...(change === "project switch" ? { projectRoot: "/other" } : {}),
        files: [replacement],
      });
      finish("old disk contents");
      await loading;
      expect(useDocumentStore.getState().files[0]).toBe(replacement);
      expect(useDocumentStore.getState().files[0].isDirty).toBe(true);
    });

    it("applies a reload when the target document is unchanged", async () => {
      vi.spyOn(fsLib, "readTexFileContent").mockResolvedValue(
        "current disk contents",
      );
      await useDocumentStore.getState().reloadFile("main.tex");
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "current disk contents",
        diskContent: "current disk contents",
        isDirty: false,
      });
    });
  });

  describe("external file changes", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it.each([
      "\r\n",
      "\r",
    ])("keeps %j disk endings outside editor coordinates", async (ending) => {
      const disk = `😀 first${ending}selected${ending}`;
      vi.spyOn(fsLib, "readTexFileContent").mockResolvedValue(disk);
      await useDocumentStore.getState().reloadFile("main.tex");
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "😀 first\nselected\n",
        diskContent: disk,
      });
      useDocumentStore
        .getState()
        .updateFileContent("main.tex", "😀 first\nselected edited\n");
      await useDocumentStore.getState().saveFile("main.tex");
      expect(invoke).toHaveBeenCalledWith(
        "save_file_if_unchanged",
        expect.objectContaining({
          expected: disk,
          content: `😀 first${ending}selected edited${ending}`,
        }),
      );
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "😀 first\nselected edited\n",
        isDirty: false,
        diskContent: `😀 first${ending}selected edited${ending}`,
      });
    });

    it("keeps dirty text when only external line endings change", async () => {
      vi.spyOn(fsLib, "exists").mockResolvedValue(true);
      vi.spyOn(fsLib, "readTexFileContent").mockResolvedValue("base\r\n");
      useDocumentStore.setState({
        files: [
          makeFile({
            content: "my edit\n",
            diskContent: "base\n",
            isDirty: true,
          }),
        ],
      });
      await useDocumentStore.getState().refreshExternalFiles(["main.tex"]);
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "my edit\n",
        diskContent: "base\r\n",
        isDirty: true,
      });
      expect(
        useDocumentStore.getState().files[0].externalChange,
      ).toBeUndefined();
      await useDocumentStore.getState().saveFile("main.tex");
      expect(invoke).toHaveBeenCalledWith(
        "save_file_if_unchanged",
        expect.objectContaining({
          expected: "base\r\n",
          content: "my edit\r\n",
        }),
      );
    });

    it("preserves typing that arrives during a full file refresh", async () => {
      vi.spyOn(fsLib, "scanProjectFolder").mockResolvedValue({
        files: [
          {
            relativePath: "main.tex",
            absolutePath: "/project/main.tex",
            type: "tex",
            fileSize: 10,
          },
        ],
        folders: [],
      });
      let finish!: (text: string) => void;
      vi.spyOn(fsLib, "readTexFileContent").mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = useDocumentStore.getState().refreshFiles();
      await vi.waitFor(() => expect(finish).toBeDefined());
      useDocumentStore.getState().setContent("typed while scanning");
      finish("disk version");
      await pending;
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "typed while scanning",
        isDirty: true,
      });
    });
    it("retains a pending draft-only selection made while source is being scanned", async () => {
      let finish!: (
        tree: Awaited<ReturnType<typeof fsLib.scanProjectFolder>>,
      ) => void;
      const scan = vi.spyOn(fsLib, "scanProjectFolder").mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      vi.spyOn(fsLib, "readTexFileContent").mockResolvedValue("source");
      const pending = useDocumentStore.getState().refreshFiles({
        pendingReviewPaths: ["new-figure.png"],
      });
      await vi.waitFor(() => expect(finish).toBeDefined());
      useDocumentStore.getState().setActiveFile("new-figure.png");
      const tree: Awaited<ReturnType<typeof fsLib.scanProjectFolder>> = {
        files: [
          {
            relativePath: "main.tex",
            absolutePath: "/project/main.tex",
            type: "tex",
            fileSize: 6,
          },
        ],
        folders: [],
      };
      finish(tree);
      await pending;
      expect(useDocumentStore.getState().activeFileId).toBe("new-figure.png");
      expect(useDocumentStore.getState().openFileIds).toContain(
        "new-figure.png",
      );
      expect(
        useDocumentStore
          .getState()
          .files.some((file) => file.id === "new-figure.png"),
      ).toBe(false);
      scan.mockResolvedValue(tree);
      await useDocumentStore.getState().refreshFiles();
      expect(useDocumentStore.getState().activeFileId).toBe("main.tex");
    });

    it("refreshes only the changed clean file", async () => {
      vi.spyOn(fsLib, "exists").mockResolvedValue(true);
      const read = vi
        .spyOn(fsLib, "readTexFileContent")
        .mockResolvedValue("External");
      await useDocumentStore.getState().refreshExternalFiles(["main.tex"]);
      expect(read).toHaveBeenCalledExactlyOnceWith("/project/main.tex");
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "External",
        isDirty: false,
      });
    });

    it("blocks a stale save even without a watcher notification", async () => {
      useDocumentStore.getState().setContent("My edits");
      vi.mocked(invoke).mockResolvedValueOnce({
        written: false,
        current: "External",
      });
      await expect(
        useDocumentStore.getState().saveFile("main.tex"),
      ).rejects.toThrow("changed on disk");
      expect(invoke).toHaveBeenCalledWith(
        "save_file_if_unchanged",
        expect.objectContaining({
          expected: "Hello World",
          content: "My edits",
        }),
      );
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "My edits",
        externalChange: { base: "Hello World", disk: "External" },
      });
      expect(writeTextFile).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2500);
      expect(writeTextFile).not.toHaveBeenCalled();
    });

    it("keeps typing that happened while an external read was pending", async () => {
      vi.spyOn(fsLib, "exists").mockResolvedValue(true);
      let finish!: (text: string) => void;
      vi.spyOn(fsLib, "readTexFileContent").mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const refresh = useDocumentStore
        .getState()
        .refreshExternalFiles(["main.tex"]);
      await vi.waitFor(() => expect(finish).toBeDefined());
      useDocumentStore.getState().setContent("Typed during read");
      finish("External");
      await refresh;
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "Typed during read",
        externalChange: { disk: "External" },
      });
    });

    it("recognizes content already saved by another app workflow", async () => {
      useDocumentStore.getState().setContent("Already written");
      vi.mocked(invoke).mockResolvedValueOnce({
        written: false,
        current: "Already written",
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        isDirty: false,
        diskContent: "Already written",
      });
      expect(
        useDocumentStore.getState().files[0].externalChange,
      ).toBeUndefined();
      expect(writeTextFile).not.toHaveBeenCalled();
    });

    it("rejects a review decision when the disk changed again", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({
            content: "Local",
            diskContent: "Base",
            isDirty: true,
            externalChange: { id: "review", base: "Base", disk: "Disk" },
          }),
        ],
      });
      vi.mocked(invoke).mockResolvedValueOnce({
        written: false,
        current: "New disk",
      });
      await expect(
        useDocumentStore
          .getState()
          .resolveExternalFile("main.tex", "review", "Reviewed"),
      ).rejects.toThrow("changed again");
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "Local",
        externalChange: { disk: "New disk" },
      });
      expect(writeTextFile).not.toHaveBeenCalled();
    });

    it("ignores file reads from the previous project", async () => {
      vi.spyOn(fsLib, "exists").mockResolvedValue(true);
      let finish!: (text: string) => void;
      vi.spyOn(fsLib, "readTexFileContent").mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const refresh = useDocumentStore
        .getState()
        .refreshExternalFiles(["main.tex"]);
      await vi.waitFor(() => expect(finish).toBeDefined());
      useDocumentStore.setState({
        projectRoot: "/other",
        files: [
          makeFile({
            absolutePath: "/other/main.tex",
            content: "Other project",
          }),
        ],
      });
      finish("Old project");
      await refresh;
      expect(useDocumentStore.getState().files[0].content).toBe(
        "Other project",
      );
    });
  });

  describe("getActiveFile logic", () => {
    it("insertAtCursor finds the correct active file", () => {
      // Validates that getActiveFile() correctly resolves the active file
      // by confirming insertAtCursor modifies the right file's content
      useDocumentStore.getState().insertAtCursor("!");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello! World");
    });

    it("returns null for nonexistent activeFileId (no-op on insert)", () => {
      useDocumentStore.setState({ activeFileId: "nonexistent" });
      useDocumentStore.getState().insertAtCursor("text");
      // Files should not be modified
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello World");
    });
  });

  describe("resolveTexRoot", () => {
    it("refreshes source facts after both immutable edits and in-place source replacement", () => {
      const chapter = makeFile({
        id: "chapter.tex",
        name: "chapter.tex",
        relativePath: "chapter.tex",
        content: "Chapter",
      });
      const root = makeFile({
        id: "book.tex",
        name: "book.tex",
        relativePath: "book.tex",
        content: "\\documentclass{book}",
      });
      const files = [chapter, root];
      expect(resolveTexRoot(chapter.id, files)).toBe(root.id);

      const edited = { ...chapter, content: "\\documentclass{article}" };
      expect(resolveTexRoot(chapter.id, [edited, root])).toBe(chapter.id);
      // External refresh callers may reuse a file object; content still invalidates.
      root.content = "No longer a root";
      expect(resolveTexRoot(chapter.id, files)).toBe(chapter.id);
      root.content = "\\documentclass{report}";
      expect(resolveTexRoot(chapter.id, files)).toBe(root.id);
    });

    it("resolves cached magic hints against current names, membership, and hidden paths", () => {
      const chapter = makeFile({
        id: "chapter.tex",
        name: "chapter.tex",
        relativePath: "chapter.tex",
        content: "% !TEX root = chosen.tex\nChapter",
      });
      const chosen = makeFile({
        id: "chosen.tex",
        name: "chosen.tex",
        relativePath: "chosen.tex",
        content: "\\documentclass{book}",
      });
      const fallback = makeFile({
        id: "main.tex",
        name: "main.tex",
        relativePath: "main.tex",
        content: "\\documentclass{article}",
      });
      expect(resolveTexRoot(chapter.id, [chapter, chosen, fallback])).toBe(
        chosen.id,
      );
      expect(resolveTexRoot(chapter.id, [chapter, fallback])).toBe(fallback.id);
      chosen.relativePath = ".hidden/chosen.tex";
      expect(resolveTexRoot(chapter.id, [chapter, chosen, fallback])).toBe(
        fallback.id,
      );
      chosen.relativePath = "renamed.tex";
      chosen.name = "renamed.tex";
      expect(resolveTexRoot(chapter.id, [chapter, chosen, fallback])).toBe(
        fallback.id,
      );
      chapter.content = "% !TEX root = renamed.tex\nChapter";
      expect(resolveTexRoot(chapter.id, [chapter, chosen, fallback])).toBe(
        chosen.id,
      );
      chapter.content = `${"\n".repeat(20)}% !TEX root = renamed.tex\nChapter`;
      expect(resolveTexRoot(chapter.id, [chapter, chosen, fallback])).toBe(
        fallback.id,
      );
    });

    it("does not carry root facts between projects sharing file IDs", () => {
      const first = makeFile({ content: "\\documentclass{article}" });
      expect(resolveTexRoot(first.id, [first])).toBe(first.id);
      const second = {
        ...first,
        absolutePath: "/other/main.tex",
        content: "Chapter",
      };
      const root = makeFile({
        id: "book.tex",
        name: "book.tex",
        relativePath: "book.tex",
        content: "\\documentclass{book}",
      });
      expect(resolveTexRoot(second.id, [second, root])).toBe(root.id);
    });

    it("ignores !TEX root targets in hidden directories and falls back to visible root logic", () => {
      const files: ProjectFile[] = [
        makeFile({
          id: "Checklist.tex",
          name: "Checklist.tex",
          relativePath: "Checklist.tex",
          absolutePath: "/project/Checklist.tex",
          content:
            "% !TEX root = .catalex/latex-build/neurips_2026.tex\n\\input{body}",
        }),
        makeFile({
          id: ".catalex/latex-build/neurips_2026.tex",
          name: "neurips_2026.tex",
          relativePath: ".catalex/latex-build/neurips_2026.tex",
          absolutePath: "/project/.catalex/latex-build/neurips_2026.tex",
          content: "\\documentclass{article}\n\\begin{document}\\end{document}",
        }),
        makeFile({
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/project/main.tex",
          content: "\\documentclass{article}\n\\begin{document}\\end{document}",
        }),
      ];

      expect(resolveTexRoot("Checklist.tex", files)).toBe("main.tex");
    });
  });

  describe("insertAtCursor", () => {
    it("inserts text at cursor position", () => {
      useDocumentStore.getState().insertAtCursor(", Beautiful");
      const state = useDocumentStore.getState();
      const file = state.files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello, Beautiful World");
      expect(file.isDirty).toBe(true);
    });

    it("updates cursor position after insert", () => {
      useDocumentStore.getState().insertAtCursor("!");
      expect(useDocumentStore.getState().cursorPosition).toBe(6);
    });

    it("inserts at beginning when cursor is at 0", () => {
      useDocumentStore.setState({ cursorPosition: 0 });
      useDocumentStore.getState().insertAtCursor(">> ");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe(">> Hello World");
    });

    it("inserts at end when cursor is at content length", () => {
      useDocumentStore.setState({ cursorPosition: 11 }); // "Hello World".length
      useDocumentStore.getState().insertAtCursor("!");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello World!");
    });

    it("does nothing for image files", () => {
      useDocumentStore.setState({
        files: [makeFile({ type: "image", content: undefined })],
      });
      useDocumentStore.getState().insertAtCursor("text");
      const file = useDocumentStore.getState().files[0];
      expect(file.content).toBeUndefined();
    });

    it("handles empty content", () => {
      useDocumentStore.setState({
        files: [makeFile({ content: "" })],
        cursorPosition: 0,
      });
      useDocumentStore.getState().insertAtCursor("New text");
      const file = useDocumentStore.getState().files[0];
      expect(file.content).toBe("New text");
    });
  });

  describe("replaceSelection", () => {
    it("replaces a range of text", () => {
      // Replace "World" (indices 6-11) with "Universe"
      useDocumentStore.getState().replaceSelection(6, 11, "Universe");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello Universe");
      expect(file.isDirty).toBe(true);
    });

    it("updates cursor position to end of replacement", () => {
      useDocumentStore.getState().replaceSelection(6, 11, "Universe");
      expect(useDocumentStore.getState().cursorPosition).toBe(14); // 6 + "Universe".length
    });

    it("can delete text (empty replacement)", () => {
      useDocumentStore.getState().replaceSelection(5, 11, "");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello");
    });

    it("can insert at a point (start === end)", () => {
      useDocumentStore.getState().replaceSelection(5, 5, " Beautiful");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello Beautiful World");
    });

    it("does nothing for pdf files", () => {
      useDocumentStore.setState({
        files: [makeFile({ type: "pdf", content: "pdf-data" })],
      });
      useDocumentStore.getState().replaceSelection(0, 3, "new");
      expect(useDocumentStore.getState().files[0].content).toBe("pdf-data");
    });
  });

  describe("findAndReplace", () => {
    it("replaces first occurrence", () => {
      const result = useDocumentStore
        .getState()
        .findAndReplace("World", "Universe");
      expect(result).toBe(true);
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello Universe");
      expect(file.isDirty).toBe(true);
    });

    it("returns false when find string is not found", () => {
      const result = useDocumentStore.getState().findAndReplace("xyz", "abc");
      expect(result).toBe(false);
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.isDirty).toBe(false); // not modified
    });

    it("replaces only first occurrence (String.replace behavior)", () => {
      useDocumentStore.setState({
        files: [makeFile({ content: "aaa bbb aaa" })],
      });
      useDocumentStore.getState().findAndReplace("aaa", "ccc");
      const file = useDocumentStore.getState().files[0];
      expect(file.content).toBe("ccc bbb aaa");
    });

    it("handles special regex characters in find string", () => {
      useDocumentStore.setState({
        files: [makeFile({ content: "price is $10.00" })],
      });
      const result = useDocumentStore
        .getState()
        .findAndReplace("$10.00", "€12.00");
      expect(result).toBe(true);
      expect(useDocumentStore.getState().files[0].content).toBe(
        "price is €12.00",
      );
    });

    it("does nothing for image files", () => {
      useDocumentStore.setState({
        files: [makeFile({ type: "image" })],
      });
      const result = useDocumentStore.getState().findAndReplace("Hello", "Bye");
      expect(result).toBe(false);
    });
  });

  describe("updateFileContent", () => {
    it("updates content and marks dirty", () => {
      useDocumentStore.getState().updateFileContent("main.tex", "New content");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("New content");
      expect(file.isDirty).toBe(true);
    });

    it("does not affect other files", () => {
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: "other.tex",
            name: "other.tex",
            relativePath: "other.tex",
            content: "Other",
          }),
        ],
      });
      useDocumentStore.getState().updateFileContent("main.tex", "Changed");
      const other = useDocumentStore
        .getState()
        .files.find((f) => f.id === "other.tex")!;
      expect(other.content).toBe("Other");
      expect(other.isDirty).toBe(false);
    });
  });

  describe("isolated agent workspace", () => {
    it("keeps the selected file, open tabs, and matching source PDF during partial acceptance", async () => {
      const files = [
        makeFile(),
        makeFile({
          id: "other.tex",
          name: "other.tex",
          relativePath: "other.tex",
          absolutePath: "/project/other.tex",
          content: "\\documentclass{article}",
        }),
      ];
      useDocumentStore.setState({ files, openFileIds: ["main.tex"] });
      const scan = vi
        .spyOn(fsLib, "scanProjectFolder")
        .mockImplementation(async (root) => ({
          files: files.map((file) => ({
            relativePath: file.relativePath,
            absolutePath: `${root}/${file.relativePath}`,
            type: file.type,
            fileSize: 32,
          })),
          folders: [],
        }));
      const read = vi
        .spyOn(fsLib, "readTexFileContent")
        .mockResolvedValue("\\documentclass{article}");
      try {
        const sourcePdf = new Uint8Array([1, 2]);
        useDocumentStore.getState().setPdfData(sourcePdf, "other.tex");
        useDocumentStore
          .getState()
          .setCompileError("Other source error", "other.tex");
        useDocumentStore.getState().setActiveFile("main.tex");
        await useDocumentStore
          .getState()
          .activateAgentWorkspace("draft", "/draft");
        useDocumentStore.getState().setActiveFile("other.tex");
        useDocumentStore
          .getState()
          .setPdfData(new Uint8Array([3, 4]), "other.tex");

        await useDocumentStore
          .getState()
          .restoreSourceWorkspace(["main.tex"], { preserveSelection: true });

        expect(useDocumentStore.getState().activeFileId).toBe("other.tex");
        expect(useDocumentStore.getState().openFileIds).toEqual([
          "main.tex",
          "other.tex",
        ]);
        expect(getCurrentPdfBytes()).toEqual(sourcePdf);
        expect(useDocumentStore.getState().compileError).toBe(
          "Other source error",
        );
      } finally {
        scan.mockRestore();
        read.mockRestore();
      }
    });

    it("keeps file selections made while the draft tree is loading", async () => {
      const files = [
        makeFile(),
        makeFile({
          id: "other.tex",
          name: "other.tex",
          relativePath: "other.tex",
          absolutePath: "/project/other.tex",
        }),
      ];
      useDocumentStore.setState({ files, openFileIds: ["main.tex"] });
      let release!: (
        tree: Awaited<ReturnType<typeof fsLib.scanProjectFolder>>,
      ) => void;
      const scan = vi.spyOn(fsLib, "scanProjectFolder").mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const read = vi
        .spyOn(fsLib, "readTexFileContent")
        .mockResolvedValue("Source");
      try {
        const activation = useDocumentStore
          .getState()
          .activateAgentWorkspace("draft", "/draft");
        useDocumentStore.getState().setActiveFile("other.tex");
        release({
          files: files.map((file) => ({
            relativePath: file.relativePath,
            absolutePath: `/draft/${file.relativePath}`,
            type: file.type,
            fileSize: 32,
          })),
          folders: [],
        });
        await activation;
        expect(useDocumentStore.getState().activeFileId).toBe("other.tex");
        expect(useDocumentStore.getState().openFileIds).toEqual([
          "main.tex",
          "other.tex",
        ]);
      } finally {
        scan.mockRestore();
        read.mockRestore();
      }
    });

    it("restores unsaved source buffers recovered from a crashed session", async () => {
      await useDocumentStore
        .getState()
        .restoreRecoveredDirtyBuffers([
          { relativePath: "main.tex", content: "Recovered draft" },
        ]);

      expect(useDocumentStore.getState().files[0]).toEqual(
        expect.objectContaining({
          relativePath: "main.tex",
          content: "Recovered draft",
          isDirty: true,
        }),
      );
    });

    it("never saves candidate workspace content into the source tree", async () => {
      useDocumentStore.setState({
        agentWorkspaceSessionId: "workspace-1",
        agentWorkspaceRoot: "/workspace/candidate",
        files: [
          makeFile({
            absolutePath: "/workspace/candidate/main.tex",
            content: "Agent draft",
            isDirty: true,
          }),
        ],
      });

      await useDocumentStore.getState().saveFile("main.tex");

      expect(writeTextFile).not.toHaveBeenCalled();
    });

    it("restores the source PDF after leaving draft review", async () => {
      const sourcePdf = new Uint8Array([1, 2, 3]);
      const candidatePdf = new Uint8Array([4, 5, 6]);
      const scanProjectFolder = vi
        .spyOn(fsLib, "scanProjectFolder")
        .mockImplementation(async (rootPath) => ({
          files: [
            {
              relativePath: "main.tex",
              absolutePath: `${rootPath}/main.tex`,
              type: "tex",
              fileSize: 16,
            },
          ],
          folders: [],
        }));
      const readTexFileContent = vi
        .spyOn(fsLib, "readTexFileContent")
        .mockImplementation(async (path) =>
          path.startsWith("/workspace") ? "Agent draft" : "Source text",
        );

      useDocumentStore.getState().setPdfData(sourcePdf, "main.tex");
      await useDocumentStore
        .getState()
        .activateAgentWorkspace("workspace-1", "/workspace/candidate");
      useDocumentStore.getState().setPdfData(candidatePdf, "main.tex");
      expect(getCurrentPdfBytes()).toEqual(candidatePdf);

      await useDocumentStore.getState().restoreSourceWorkspace();

      expect(getCurrentPdfBytes()).toEqual(sourcePdf);
      expect(useDocumentStore.getState().agentWorkspaceRoot).toBeNull();
      expect(useDocumentStore.getState().files[0].content).toBe("Source text");

      scanProjectFolder.mockRestore();
      readTexFileContent.mockRestore();
    });
  });

  describe("addFile", () => {
    it("adds a new file and sets it active", () => {
      const id = useDocumentStore.getState().addFile({
        name: "refs.bib",
        relativePath: "refs.bib",
        absolutePath: "/project/refs.bib",
        type: "bib",
        content: "@article{...}",
      });
      expect(id).toBe("refs.bib");
      const state = useDocumentStore.getState();
      expect(state.files).toHaveLength(2);
      expect(state.activeFileId).toBe("refs.bib");
    });
  });

  describe("setActiveFile", () => {
    it("opens a background tab once without changing editing or preview state", () => {
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: "notes.md",
            name: "notes.md",
            relativePath: "notes.md",
          }),
        ],
        activeFileId: "main.tex",
        openFileIds: ["main.tex"],
        cursorPosition: 10,
        selectionRange: { start: 2, end: 8 },
        pdfRevision: 7,
      });
      for (const id of ["notes.md", "notes.md", "missing.md"]) {
        useDocumentStore.getState().openFileInBackground(id);
      }
      expect(useDocumentStore.getState()).toMatchObject({
        activeFileId: "main.tex",
        openFileIds: ["main.tex", "notes.md"],
        cursorPosition: 10,
        selectionRange: { start: 2, end: 8 },
        pdfRevision: 7,
      });
    });

    it("changes active file and resets selection", () => {
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({ id: "ch1.tex", name: "ch1.tex", relativePath: "ch1.tex" }),
        ],
        cursorPosition: 100,
        selectionRange: { start: 10, end: 20 },
      });
      useDocumentStore.getState().setActiveFile("ch1.tex");
      const state = useDocumentStore.getState();
      expect(state.activeFileId).toBe("ch1.tex");
      // cursorPosition is preserved — the editor restores it from per-file cache
      expect(state.cursorPosition).toBe(100);
      expect(state.selectionRange).toBeNull();
    });
  });

  describe("moving project entries", () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
      "file",
      "folder",
    ])("preserves dirty drafts, tabs and PDF caches when moving a %s", async (kind) => {
      const original = "draft/note.tex";
      const moved =
        kind === "file" ? "target/note (1).tex" : "target/draft (1)/note.tex";
      vi.spyOn(fsLib, "getUniqueTargetName").mockResolvedValue(
        kind === "file" ? moved : "target/draft (1)",
      );
      vi.spyOn(fsLib, "renameFileOnDisk").mockImplementation(async () => {
        useDocumentStore.setState((state) => ({
          files: state.files.map((file) =>
            file.id === original
              ? { ...file, content: "edited during move", isDirty: true }
              : file,
          ),
        }));
      });
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: original,
            relativePath: original,
            absolutePath: `/project/${original}`,
            name: "note.tex",
            content: "draft",
            isDirty: true,
          }),
        ],
        folders: ["draft", "draft/empty", "target"],
        activeFileId: original,
        openFileIds: ["main.tex", original],
        compileErrorCache: new Map([[original, "error"]]),
        lastCompiledGenerations: new Map([[original, 3]]),
      });
      const bytes = new Uint8Array([1, 2]);
      useDocumentStore.getState().setPdfData(bytes, original);
      useDocumentStore.getState().setCompileError("error", original);
      const result =
        kind === "file"
          ? await useDocumentStore.getState().moveFile(original, "target")
          : await useDocumentStore.getState().moveFolder("draft", "target");
      expect(result).toBe(kind === "file" ? moved : "target/draft (1)");
      const state = useDocumentStore.getState();
      expect(state.files[1]).toMatchObject({
        id: moved,
        absolutePath: `/project/${moved}`,
        content: "edited during move",
        isDirty: true,
      });
      expect(state.openFileIds).toEqual(["main.tex", moved]);
      expect(state.activeFileId).toBe(moved);
      expect(getCurrentPdfBytes()).toEqual(bytes);
      expect(state.compileErrorCache.get(moved)).toBe("error");
      if (kind === "folder")
        expect(state.folders).toEqual([
          "target/draft (1)",
          "target/draft (1)/empty",
          "target",
        ]);
    });

    it("waits for an in-flight save before renaming its path", async () => {
      let finishSave!: (value: { written: boolean; current: null }) => void;
      vi.mocked(invoke).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishSave = resolve;
          }),
      );
      const renameOnDisk = vi
        .spyOn(fsLib, "renameFileOnDisk")
        .mockResolvedValue();
      vi.spyOn(fsLib, "getUniqueTargetName").mockResolvedValue(
        "target/main.tex",
      );
      useDocumentStore.setState({ files: [makeFile({ isDirty: true })] });
      const saving = useDocumentStore.getState().saveFile("main.tex");
      await vi.waitFor(() => expect(finishSave).toBeDefined());
      const moving = useDocumentStore.getState().moveFile("main.tex", "target");
      await Promise.resolve();
      expect(renameOnDisk).not.toHaveBeenCalled();
      finishSave({ written: true, current: null });
      await saving;
      await moving;
      expect(renameOnDisk).toHaveBeenCalledWith(
        "/project/main.tex",
        "/project/target/main.tex",
      );
      expect(useDocumentStore.getState().files[0].isDirty).toBe(false);
    });

    it("does not remap the next project when switching during a move", async () => {
      vi.spyOn(fsLib, "getUniqueTargetName").mockResolvedValue(
        "target/main.tex",
      );
      vi.spyOn(fsLib, "renameFileOnDisk").mockImplementation(async () => {
        useDocumentStore.setState({
          projectRoot: "/other",
          files: [makeFile({ content: "other project" })],
        });
      });
      expect(
        await useDocumentStore.getState().moveFile("main.tex", "target"),
      ).toBeUndefined();
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        id: "main.tex",
        content: "other project",
      });
    });

    it("leaves the tree unchanged when the disk move fails", async () => {
      vi.spyOn(fsLib, "getUniqueTargetName").mockResolvedValue(
        "target/main.tex",
      );
      vi.spyOn(fsLib, "renameFileOnDisk").mockRejectedValue(
        new Error("permission denied"),
      );
      const files = useDocumentStore.getState().files;
      await expect(
        useDocumentStore.getState().moveFile("main.tex", "target"),
      ).rejects.toThrow("permission denied");
      expect(useDocumentStore.getState().files).toBe(files);
    });
  });

  describe.each([
    "delete file",
    "delete folder",
    "rename file",
    "rename folder",
  ])("delayed %s", (operation) => {
    afterEach(() => vi.restoreAllMocks());
    const target = "draft/note.tex";
    let started: Promise<void>;
    let release: () => void;
    let diskOperation: MockInstance<
      typeof fsLib.renameFileOnDisk | typeof fsLib.deleteFileFromDisk
    >;
    const run = () => {
      const store = useDocumentStore.getState();
      switch (operation) {
        case "delete file":
          return store.deleteFile(target);
        case "delete folder":
          return store.deleteFolder("draft");
        case "rename file":
          return store.renameFile(target, "renamed.tex");
        default:
          return store.renameFolder("draft", "renamed");
      }
    };
    beforeEach(() => {
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: target,
            relativePath: target,
            absolutePath: `/project/${target}`,
            name: "note.tex",
          }),
        ],
        folders: ["draft"],
        openFileIds: ["main.tex", target],
      });
      let notify!: () => void;
      started = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const method =
        operation === "delete file"
          ? "deleteFileFromDisk"
          : operation === "delete folder"
            ? "deleteFolderFromDisk"
            : "renameFileOnDisk";
      diskOperation = vi.spyOn(fsLib, method).mockImplementation(async () => {
        notify();
        await pending;
      });
    });
    it("preserves edits, selection, and caches arriving during disk I/O", async () => {
      const pending = run();
      await started;
      useDocumentStore
        .getState()
        .updateFileContent("main.tex", "latest surviving writing");
      if (operation.startsWith("rename"))
        useDocumentStore
          .getState()
          .updateFileContent(target, "latest renamed writing");
      useDocumentStore.setState({
        activeFileId: "main.tex",
        compileErrorCache: new Map([["main.tex", "latest diagnostic"]]),
      });
      release();
      await pending;
      const state = useDocumentStore.getState();
      expect(state.files.find((file) => file.id === "main.tex")).toMatchObject({
        content: "latest surviving writing",
        isDirty: true,
      });
      expect(state.activeFileId).toBe("main.tex");
      expect(state.compileErrorCache.get("main.tex")).toBe("latest diagnostic");
      if (operation.startsWith("rename"))
        expect(state.files[1]).toMatchObject({
          content: "latest renamed writing",
          isDirty: true,
        });
    });
    it.each([
      false,
      true,
    ])("discards publication after switching projects (return=%s)", async (returnToProject) => {
      const pending = run();
      await started;
      useDocumentStore.setState({ projectRoot: "/other" });
      if (returnToProject)
        useDocumentStore.setState({ projectRoot: "/project" });
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: target,
            relativePath: target,
            absolutePath: `${returnToProject ? "/project" : "/other"}/${target}`,
            content: "new workspace",
          }),
        ],
        folders: ["draft"],
        activeFileId: target,
        compileErrorCache: new Map([[target, "new workspace error"]]),
      });
      const current = useDocumentStore.getState();
      release();
      await pending;
      expect(useDocumentStore.getState().files).toBe(current.files);
      expect(useDocumentStore.getState().folders).toBe(current.folders);
      expect(useDocumentStore.getState().compileErrorCache).toBe(
        current.compileErrorCache,
      );
      expect(useDocumentStore.getState().activeFileId).toBe(target);
    });
    it("serializes a second mutation and saves edits after the first completes", async () => {
      const pending = run();
      await started;
      const second = useDocumentStore
        .getState()
        .renameFile("main.tex", "second.tex");
      useDocumentStore
        .getState()
        .updateFileContent("main.tex", "edited while waiting");
      await Promise.resolve();
      expect(diskOperation).toHaveBeenCalledTimes(1);
      const saving = useDocumentStore
        .getState()
        .saveAllFiles({ requireClean: true });
      const manualSave = useDocumentStore.getState().saveFile("main.tex");
      release();
      await Promise.all([pending, second, saving, manualSave]);
      expect(
        useDocumentStore
          .getState()
          .files.find((file) => file.id === "second.tex"),
      ).toMatchObject({ content: "edited while waiting", isDirty: false });
      expect(writeTextFile).toHaveBeenCalledWith(
        "/project/main.tex",
        "edited while waiting",
      );
    });
    it("cancels before disk I/O when a pending save fails", async () => {
      let reject!: (reason: Error) => void;
      vi.mocked(writeTextFile).mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail;
          }),
      );
      useDocumentStore
        .getState()
        .updateFileContent("main.tex", "unsaved writing");
      const saving = useDocumentStore.getState().saveFile("main.tex");
      const failed = expect(saving).rejects.toThrow("Disk full");
      await vi.waitFor(() => expect(reject).toBeDefined());
      const pending = run();
      await Promise.resolve();
      await Promise.resolve();
      reject(new Error("Disk full"));
      await failed;
      await pending;
      expect(diskOperation).not.toHaveBeenCalled();
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "unsaved writing",
        isDirty: true,
      });
    });
  });

  describe("renameFolder", () => {
    beforeEach(() => {
      vi.mocked(rename).mockClear();
      vi.mocked(rename).mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("renames a folder on disk and remaps descendant project state directly", async () => {
      const scanProjectFolder = vi.spyOn(fsLib, "scanProjectFolder");
      useDocumentStore.setState({
        projectRoot: "/project",
        files: [
          makeFile({
            id: "chapters/intro.tex",
            name: "intro.tex",
            relativePath: "chapters/intro.tex",
            absolutePath: "/project/chapters/intro.tex",
          }),
          makeFile({
            id: "chapters/nested/figure.png",
            name: "figure.png",
            relativePath: "chapters/nested/figure.png",
            absolutePath: "/project/chapters/nested/figure.png",
            type: "image",
          }),
          makeFile({
            id: "main.tex",
            name: "main.tex",
            relativePath: "main.tex",
            absolutePath: "/project/main.tex",
          }),
        ],
        folders: ["chapters", "chapters/nested"],
        activeFileId: "chapters/intro.tex",
        openFileIds: ["main.tex", "chapters/intro.tex"],
        compileErrorCache: new Map([["chapters/intro.tex", "bad tex"]]),
        compileDiagnosticsCache: new Map([
          [
            "chapters/intro.tex",
            [{ severity: "warning", message: "Missing reference" }],
          ],
        ]),
        lastCompiledGenerations: new Map([["chapters/intro.tex", 12]]),
      });

      const newFolderPath = await useDocumentStore
        .getState()
        .renameFolder("chapters", "sections");

      expect(newFolderPath).toBe("sections");
      expect(rename).toHaveBeenCalledWith(
        "/project/chapters",
        "/project/sections",
      );
      expect(scanProjectFolder).not.toHaveBeenCalled();

      const state = useDocumentStore.getState();
      expect(state.folders).toEqual(["sections", "sections/nested"]);
      expect(state.files.map((file) => file.id)).toEqual([
        "sections/intro.tex",
        "sections/nested/figure.png",
        "main.tex",
      ]);
      expect(state.files[0].absolutePath).toBe("/project/sections/intro.tex");
      expect(state.files[1].absolutePath).toBe(
        "/project/sections/nested/figure.png",
      );
      expect(state.activeFileId).toBe("sections/intro.tex");
      expect(state.openFileIds).toEqual(["main.tex", "sections/intro.tex"]);
      expect(state.compileErrorCache.get("sections/intro.tex")).toBe("bad tex");
      expect(
        state.compileDiagnosticsCache.get("sections/intro.tex")?.[0].message,
      ).toBe("Missing reference");
      expect(state.compileDiagnosticsCache.has("chapters/intro.tex")).toBe(
        false,
      );
      expect(state.lastCompiledGenerations.get("sections/intro.tex")).toBe(12);
    });
  });

  describe("openProject default file selection", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("prefers a shallower .tex file when no well-known filename exists", async () => {
      vi.spyOn(fsLib, "scanProjectFolder").mockResolvedValue({
        files: [
          {
            relativePath: "chapters/intro.tex",
            absolutePath: "/project/chapters/intro.tex",
            type: "tex",
            fileSize: 10,
          },
          {
            relativePath: "paper.tex",
            absolutePath: "/project/paper.tex",
            type: "tex",
            fileSize: 12,
          },
        ],
        folders: ["chapters"],
      });
      vi.spyOn(fsLib, "readTexFileContent").mockResolvedValue("\\section{X}");

      await useDocumentStore.getState().openProject("/project");

      const state = useDocumentStore.getState();
      expect(state.activeFileId).toBe("paper.tex");
      expect(state.openFileIds).toEqual(["paper.tex"]);
    });

    it("prefers shallower well-known tex files among main/document candidates", async () => {
      vi.spyOn(fsLib, "scanProjectFolder").mockResolvedValue({
        files: [
          {
            relativePath: "chapters/main.tex",
            absolutePath: "/project/chapters/main.tex",
            type: "tex",
            fileSize: 20,
          },
          {
            relativePath: "document.tex",
            absolutePath: "/project/document.tex",
            type: "tex",
            fileSize: 30,
          },
        ],
        folders: ["chapters"],
      });
      vi.spyOn(fsLib, "readTexFileContent").mockResolvedValue(
        "\\documentclass",
      );

      await useDocumentStore.getState().openProject("/project");

      const state = useDocumentStore.getState();
      expect(state.activeFileId).toBe("document.tex");
      expect(state.openFileIds).toEqual(["document.tex"]);
    });
  });

  describe("saveFile", () => {
    beforeEach(() => {
      vi.mocked(writeTextFile).mockClear();
      vi.mocked(writeTextFile).mockResolvedValue(undefined);
    });

    it("saves a dirty file with content to disk", async () => {
      useDocumentStore.setState({
        files: [makeFile({ isDirty: true, content: "saved content" })],
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(writeTextFile).toHaveBeenCalledWith(
        "/project/main.tex",
        "saved content",
      );
      expect(useDocumentStore.getState().files[0].isDirty).toBe(false);
    });

    it("saves a dirty file with empty string content (regression: empty content is not falsy-skipped)", async () => {
      useDocumentStore.setState({
        files: [makeFile({ isDirty: true, content: "" })],
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(writeTextFile).toHaveBeenCalledWith("/project/main.tex", "");
      expect(useDocumentStore.getState().files[0].isDirty).toBe(false);
    });

    it("skips saving when content is null", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ isDirty: true, content: null as unknown as string }),
        ],
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(writeTextFile).not.toHaveBeenCalled();
    });

    it("skips saving when file is not dirty", async () => {
      useDocumentStore.setState({
        files: [makeFile({ isDirty: false, content: "clean" })],
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(writeTextFile).not.toHaveBeenCalled();
    });
  });

  describe("save ordering", () => {
    afterEach(() => vi.restoreAllMocks());

    it("keeps edits made during a save dirty", async () => {
      let finishWrite!: () => void;
      vi.mocked(writeTextFile).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishWrite = resolve;
          }),
      );
      useDocumentStore.setState({
        files: [makeFile({ content: "first", isDirty: true })],
      });
      const save = useDocumentStore.getState().saveFile("main.tex");
      await vi.waitFor(() => expect(finishWrite).toBeDefined());
      useDocumentStore.getState().updateFileContent("main.tex", "newer edit");
      finishWrite();
      await save;
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "newer edit",
        isDirty: true,
      });
    });
  });

  describe("bounded autosave", () => {
    beforeEach(async () => {
      // Reset the workspace timer without exporting timer internals for tests.
      useDocumentStore.setState({ projectRoot: null });
      useDocumentStore.setState({ projectRoot: "/project" });
      vi.useFakeTimers();
      vi.mocked(writeTextFile).mockReset().mockResolvedValue(undefined);
    });
    afterEach(() => {
      useDocumentStore.setState({ projectRoot: null });
      vi.useRealTimers();
    });

    it("keeps the two-second idle save and does not repeat clean writes", async () => {
      useDocumentStore.getState().updateFileContent("main.tex", "idle edit");
      await vi.advanceTimersByTimeAsync(1999);
      expect(writeTextFile).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(writeTextFile).toHaveBeenCalledExactlyOnceWith(
        "/project/main.tex",
        "idle edit",
      );
      await vi.advanceTimersByTimeAsync(10000);
      expect(writeTextFile).toHaveBeenCalledTimes(1);
    });

    it("saves the latest text every five seconds during continuous typing", async () => {
      for (let second = 0; second < 10; second++) {
        useDocumentStore
          .getState()
          .updateFileContent("main.tex", `edit ${second}`);
        await vi.advanceTimersByTimeAsync(1000);
        expect(writeTextFile).toHaveBeenCalledTimes(
          Math.floor((second + 1) / 5),
        );
      }
      expect(
        vi.mocked(writeTextFile).mock.calls.map((call) => call[1]),
      ).toEqual(["edit 4", "edit 9"]);
      expect(useDocumentStore.getState().files[0].isDirty).toBe(false);
    });

    it("keeps typing available during a slow save and coalesces subsequent edits", async () => {
      let finish!: () => void;
      vi.mocked(writeTextFile).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      useDocumentStore.getState().updateFileContent("main.tex", "first");
      await vi.advanceTimersByTimeAsync(2000);
      for (let second = 0; second < 12; second++) {
        useDocumentStore
          .getState()
          .updateFileContent("main.tex", `new ${second}`);
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(writeTextFile).toHaveBeenCalledTimes(1);
      expect(useDocumentStore.getState().files[0].content).toBe("new 11");
      finish();
      await vi.advanceTimersByTimeAsync(2000);
      expect(
        vi.mocked(writeTextFile).mock.calls.map((call) => call[1]),
      ).toEqual(["first", "new 11"]);
      expect(useDocumentStore.getState().files[0].isDirty).toBe(false);
    });

    it("does not keep retrying a failed save without further edits", async () => {
      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error("Disk full"));
      useDocumentStore.getState().updateFileContent("main.tex", "unsaved");
      await vi.advanceTimersByTimeAsync(15000);
      expect(writeTextFile).toHaveBeenCalledTimes(1);
      expect(useDocumentStore.getState().files[0].isDirty).toBe(true);
      useDocumentStore.getState().updateFileContent("main.tex", "retry edit");
      await vi.advanceTimersByTimeAsync(2000);
      expect(useDocumentStore.getState().files[0].isDirty).toBe(false);
    });

    it("does not carry an old deadline into a different project", async () => {
      for (let second = 0; second < 4; second++) {
        useDocumentStore
          .getState()
          .updateFileContent("main.tex", `old ${second}`);
        await vi.advanceTimersByTimeAsync(1000);
      }
      useDocumentStore.setState({
        projectRoot: "/other",
        files: [makeFile({ absolutePath: "/other/main.tex" })],
      });
      useDocumentStore.getState().updateFileContent("main.tex", "new project");
      await vi.advanceTimersByTimeAsync(1000);
      expect(writeTextFile).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(writeTextFile).toHaveBeenCalledExactlyOnceWith(
        "/other/main.tex",
        "new project",
      );
    });

    it.each([
      "external",
      "review",
      "git",
    ])("does not autosave through a %s guard", async (guard) => {
      for (let second = 0; second < 5; second++) {
        useDocumentStore
          .getState()
          .updateFileContent("main.tex", `edit ${second}`);
        if (second === 4) {
          if (guard === "external")
            useDocumentStore.setState({
              files: [
                makeFile({
                  isDirty: true,
                  externalChange: {
                    id: "disk-change",
                    base: "Hello World",
                    disk: "external",
                  },
                }),
              ],
            });
          if (guard === "review")
            useDocumentStore.setState({ isAgentWorkspaceReadOnly: true });
          if (guard === "git")
            useDocumentStore.setState({ isGitOperationRunning: true });
        }
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(writeTextFile).not.toHaveBeenCalled();
    });
  });

  describe("Git operation buffer coordination", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.mocked(writeTextFile).mockReset().mockResolvedValue(undefined);
      vi.spyOn(fsLib, "scanProjectFolder").mockResolvedValue({
        files: [
          {
            relativePath: "main.tex",
            absolutePath: "/project/main.tex",
            type: "tex",
            fileSize: 0,
          },
        ],
        folders: [],
      });
      vi.spyOn(fsLib, "readTexFileContent").mockResolvedValue("restored");
    });
    afterEach(async () => {
      await vi.advanceTimersByTimeAsync(2100);
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("blocks Git before saving when a proposal is awaiting review", async () => {
      const { useProposedChangesStore } = await import(
        "./proposed-changes-store"
      );
      const previous = useProposedChangesStore.getState().changes;
      useProposedChangesStore.setState({
        changes: [
          {
            id: "pending",
            filePath: "main.tex",
            absolutePath: "/project/main.tex",
            oldContent: "old",
            newContent: "new",
            toolName: "Edit",
            timestamp: 0,
          },
        ],
      });
      const operation = vi.fn();
      try {
        await expect(
          useDocumentStore
            .getState()
            .runGitOperation("/project", {}, operation),
        ).rejects.toThrow("Finish agent review");
        expect(operation).not.toHaveBeenCalled();
        expect(writeTextFile).not.toHaveBeenCalled();
      } finally {
        useProposedChangesStore.setState({ changes: previous });
      }
    });

    it("rechecks review after preparing the Git history checkpoint", async () => {
      const { useProposedChangesStore } = await import(
        "./proposed-changes-store"
      );
      const previous = useProposedChangesStore.getState().changes;
      historyMock.createSnapshot.mockImplementationOnce(async () => {
        useProposedChangesStore.setState({
          changes: [
            {
              id: "arrived-during-preparation",
              filePath: "main.tex",
              absolutePath: "/project/main.tex",
              oldContent: "old",
              newContent: "new",
              toolName: "Edit",
              timestamp: 0,
            },
          ],
        });
      });
      const operation = vi.fn();
      try {
        await expect(
          useDocumentStore.getState().runGitOperation(
            "/project",
            {
              history: { label: "reset", before: true },
            },
            operation,
          ),
        ).rejects.toThrow("Finish agent review");
        expect(operation).not.toHaveBeenCalled();
        expect(useDocumentStore.getState().isGitOperationRunning).toBe(false);
      } finally {
        useProposedChangesStore.setState({ changes: previous });
      }
    });

    it("captures unsaved reset targets before Git runs and checkpoints the result", async () => {
      const order: string[] = [];
      useDocumentStore.setState({
        files: [makeFile({ content: "unsaved", isDirty: true })],
      });
      vi.mocked(writeTextFile).mockImplementation(async () => {
        order.push("save");
      });
      historyMock.createSnapshot.mockImplementation(async (_root, message) => {
        order.push(message);
      });
      await useDocumentStore.getState().runGitOperation(
        "/project",
        {
          saveFiles: [],
          discardFiles: ["main.tex"],
          history: { label: "reset", before: true },
        },
        async () => {
          order.push("reset");
        },
      );
      expect(order).toEqual([
        "save",
        "[git] Before reset",
        "reset",
        "[git] After reset",
      ]);
      expect(writeTextFile).toHaveBeenCalledWith(
        "/project/main.tex",
        "unsaved",
      );
      expect(useDocumentStore.getState().files[0].content).toBe("restored");
    });

    it("cancels destructive Git actions when the safety checkpoint fails", async () => {
      historyMock.createSnapshot.mockRejectedValueOnce(
        new Error("History unavailable"),
      );
      const reset = vi.fn();
      await expect(
        useDocumentStore.getState().runGitOperation(
          "/project",
          {
            history: { label: "reset", before: true },
          },
          reset,
        ),
      ).rejects.toThrow("History unavailable");
      expect(reset).not.toHaveBeenCalled();
      expect(useDocumentStore.getState().isGitOperationRunning).toBe(false);
    });

    it("keeps a successful commit successful when its after checkpoint fails", async () => {
      historyMock.createSnapshot.mockRejectedValueOnce(
        new Error("History unavailable"),
      );
      const commit = vi.fn(async () => "committed");
      await expect(
        useDocumentStore.getState().runGitOperation(
          "/project",
          {
            history: { label: "commit" },
          },
          commit,
        ),
      ).resolves.toBe("committed");
      expect(commit).toHaveBeenCalledOnce();
      expect(historyMock.createSnapshot).toHaveBeenCalledExactlyOnceWith(
        "/project",
        "[git] After commit",
      );
    });

    it("checkpoints partial Git results while preserving the original failure", async () => {
      await expect(
        useDocumentStore.getState().runGitOperation(
          "/project",
          {
            history: { label: "pull", before: true },
          },
          async () => {
            throw new Error("Merge conflict");
          },
        ),
      ).rejects.toThrow("Merge conflict");
      expect(
        historyMock.createSnapshot.mock.calls.map((call) => call[1]),
      ).toEqual(["[git] Before pull", "[git] After pull"]);
    });

    it("keeps an unresolved binary tab available when a failed Git action refreshes filtered files", async () => {
      const binary = makeFile({
        id: "data.bin",
        name: "data.bin",
        relativePath: "data.bin",
        absolutePath: "/project/data.bin",
        type: "other",
        content: undefined,
      });
      useDocumentStore.setState({
        files: [makeFile(), binary],
        activeFileId: "data.bin",
        openFileIds: ["data.bin"],
      });
      vi.mocked(invoke).mockResolvedValueOnce({
        files: [{ document_path: "data.bin" }],
      });
      try {
        await expect(
          useDocumentStore
            .getState()
            .runGitOperation(
              "/project",
              { saveFiles: [], discardFiles: ["data.bin"] },
              async () => {
                throw new Error("Index locked");
              },
            ),
        ).rejects.toThrow("Index locked");
        expect(useDocumentStore.getState().activeFileId).toBe("data.bin");
        expect(useDocumentStore.getState().files).toContainEqual(binary);
        expect(writeTextFile).not.toHaveBeenCalled();
      } finally {
        vi.mocked(invoke).mockReset();
      }
    });

    it("reset discards only selected buffers and preserves other unsaved edits", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ content: "discard", isDirty: true }),
          makeFile({
            id: "notes.tex",
            relativePath: "notes.tex",
            absolutePath: "/project/notes.tex",
            content: "keep",
            isDirty: true,
          }),
        ],
      });
      const reset = vi.fn(async () => "done");
      await useDocumentStore
        .getState()
        .runGitOperation(
          "/project",
          { saveFiles: [], discardFiles: ["main.tex"] },
          reset,
        );
      expect(reset).toHaveBeenCalledOnce();
      expect(useDocumentStore.getState().files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "main.tex",
            content: "restored",
            isDirty: false,
          }),
          expect.objectContaining({
            id: "notes.tex",
            content: "keep",
            isDirty: true,
          }),
        ]),
      );
      expect(writeTextFile).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2100);
      expect(writeTextFile).toHaveBeenCalledExactlyOnceWith(
        "/project/notes.tex",
        "keep",
      );
    });

    it("ignores a refresh started before reset so it cannot revive discarded edits", async () => {
      useDocumentStore.setState({
        files: [makeFile({ content: "discard", isDirty: true })],
      });
      let finishScan!: (result: fsLib.ScanResult) => void;
      vi.mocked(fsLib.scanProjectFolder).mockImplementationOnce(
        () =>
          new Promise<fsLib.ScanResult>((resolve) => {
            finishScan = resolve;
          }),
      );
      const oldRefresh = useDocumentStore.getState().refreshFiles();
      await useDocumentStore
        .getState()
        .runGitOperation(
          "/project",
          { saveFiles: [], discardFiles: ["main.tex"] },
          async () => {},
        );
      finishScan({
        files: [
          {
            relativePath: "main.tex",
            absolutePath: "/project/main.tex",
            type: "tex",
            fileSize: 0,
          },
        ],
        folders: [],
      });
      await oldRefresh;
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "restored",
        isDirty: false,
      });
    });

    it("a failed reset preserves dirty content and resumes autosave", async () => {
      useDocumentStore
        .getState()
        .updateFileContent("main.tex", "keep on failure");
      await expect(
        useDocumentStore
          .getState()
          .runGitOperation(
            "/project",
            { saveFiles: [], discardFiles: ["main.tex"] },
            async () => {
              throw new Error("Git failed");
            },
          ),
      ).rejects.toThrow("Git failed");
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "keep on failure",
        isDirty: true,
      });
      expect(useDocumentStore.getState().isGitOperationRunning).toBe(false);
      await vi.advanceTimersByTimeAsync(2100);
      expect(writeTextFile).toHaveBeenCalledExactlyOnceWith(
        "/project/main.tex",
        "keep on failure",
      );
    });

    it("does not run a second Git mutation while the first one is pending", async () => {
      let finish!: () => void;
      const firstOperation = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const first = useDocumentStore
        .getState()
        .runGitOperation("/project", {}, firstOperation);
      await vi.advanceTimersByTimeAsync(0);
      const secondOperation = vi.fn();
      await expect(
        useDocumentStore
          .getState()
          .runGitOperation("/project", {}, secondOperation),
      ).rejects.toThrow("Another Git operation");
      expect(secondOperation).not.toHaveBeenCalled();
      finish();
      await first;
      expect(useDocumentStore.getState().isGitOperationRunning).toBe(false);
    });

    it("serializes overlapping saves and keeps the newest disk write last", async () => {
      let finish!: () => void;
      vi.mocked(writeTextFile).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      useDocumentStore.getState().updateFileContent("main.tex", "older");
      const first = useDocumentStore.getState().saveFile("main.tex");
      await vi.advanceTimersByTimeAsync(0);
      useDocumentStore.getState().updateFileContent("main.tex", "newer");
      const second = useDocumentStore.getState().saveFile("main.tex");
      await vi.advanceTimersByTimeAsync(0);
      expect(writeTextFile).toHaveBeenCalledTimes(1);
      finish();
      await Promise.all([first, second]);
      expect(
        vi.mocked(writeTextFile).mock.calls.map((call) => call[1]),
      ).toEqual(["older", "newer"]);
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "newer",
        isDirty: false,
      });
    });
  });

  describe("saveAllFiles", () => {
    beforeEach(() => {
      vi.mocked(writeTextFile).mockClear();
      vi.mocked(writeTextFile).mockResolvedValue(undefined);
    });

    it("reports the failing path and preserves dirty text for strict startup saves", async () => {
      useDocumentStore.setState({
        files: [makeFile({ isDirty: true, content: "Latest edits" })],
      });
      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error("Disk full"));
      await expect(
        useDocumentStore.getState().saveAllFiles({ requireClean: true }),
      ).rejects.toThrow("main.tex");
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "Latest edits",
        isDirty: true,
      });
    });

    it("rejects strict startup saves if text changes while a write is pending", async () => {
      useDocumentStore.setState({
        files: [makeFile({ isDirty: true, content: "First edit" })],
      });
      let finishWrite!: () => void;
      vi.mocked(writeTextFile).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishWrite = resolve;
          }),
      );
      const saving = useDocumentStore
        .getState()
        .saveAllFiles({ requireClean: true });
      const rejected = expect(saving).rejects.toThrow("changed while saving");
      await vi.waitFor(() => expect(finishWrite).toBeDefined());
      useDocumentStore.setState({
        files: [makeFile({ isDirty: true, content: "Newer edit" })],
      });
      finishWrite();
      await rejected;
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "Newer edit",
        isDirty: true,
      });
    });

    it("rejects strict saves when source saving is unavailable", async () => {
      useDocumentStore.setState({ agentWorkspaceRoot: "/draft" });
      await expect(
        useDocumentStore.getState().saveAllFiles({ requireClean: true }),
      ).rejects.toThrow("source");
      expect(writeTextFile).not.toHaveBeenCalled();
    });

    it("waits behind an in-flight autosave and persists the latest text", async () => {
      let finishFirst!: () => void;
      vi.mocked(writeTextFile).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      );
      useDocumentStore.setState({
        files: [makeFile({ isDirty: true, content: "Older edit" })],
      });
      const autosave = useDocumentStore.getState().saveFile("main.tex");
      await vi.waitFor(() => expect(finishFirst).toBeDefined());
      useDocumentStore.setState({
        files: [makeFile({ isDirty: true, content: "Latest edit" })],
      });
      let done = false;
      const startupSave = useDocumentStore
        .getState()
        .saveAllFiles({ requireClean: true })
        .then(() => {
          done = true;
        });
      await Promise.resolve();
      expect(done).toBe(false);
      finishFirst();
      await Promise.all([autosave, startupSave]);
      expect(
        vi.mocked(writeTextFile).mock.calls.map((call) => call[1]),
      ).toEqual(["Older edit", "Latest edit"]);
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "Latest edit",
        isDirty: false,
      });
    });

    it("saves all dirty files", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ isDirty: true, content: "dirty content" }),
          makeFile({
            id: "clean.tex",
            name: "clean.tex",
            absolutePath: "/project/clean.tex",
            relativePath: "clean.tex",
            isDirty: false,
            content: "clean",
          }),
        ],
      });
      await useDocumentStore.getState().saveAllFiles();
      expect(writeTextFile).toHaveBeenCalledTimes(1);
      expect(writeTextFile).toHaveBeenCalledWith(
        "/project/main.tex",
        "dirty content",
      );
    });

    it("saves dirty files with empty string content (regression: empty string is not falsy-skipped)", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ isDirty: true, content: "" }),
          makeFile({
            id: "slide.tex",
            name: "slide.tex",
            absolutePath: "/project/slide.tex",
            relativePath: "slide.tex",
            isDirty: true,
            content: "",
          }),
        ],
      });
      await useDocumentStore.getState().saveAllFiles();
      expect(writeTextFile).toHaveBeenCalledTimes(2);
      expect(writeTextFile).toHaveBeenCalledWith("/project/main.tex", "");
      expect(writeTextFile).toHaveBeenCalledWith("/project/slide.tex", "");
      // Both should be marked clean
      const files = useDocumentStore.getState().files;
      expect(files.every((f) => !f.isDirty)).toBe(true);
    });

    it("skips files with null content even if dirty", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ isDirty: true, content: null as unknown as string }),
        ],
      });
      await useDocumentStore.getState().saveAllFiles();
      expect(writeTextFile).not.toHaveBeenCalled();
    });
  });

  describe("setPdfData / setCompileError", () => {
    it("resets stale MuPDF work before publishing new compiled PDF bytes", async () => {
      const { prepareForNewPdfRevision } = await import(
        "@/lib/mupdf/pdf-doc-cache"
      );
      vi.mocked(prepareForNewPdfRevision).mockClear();

      useDocumentStore
        .getState()
        .setPdfData(new Uint8Array([1, 2, 3]), "main.tex");

      expect(prepareForNewPdfRevision).toHaveBeenCalledTimes(1);
    });

    it("keeps root diagnostics until the next result and clears stale warnings on failure", () => {
      const warning = {
        severity: "warning" as const,
        message: "Undefined reference",
      };
      const store = useDocumentStore.getState();
      store.setPdfData(new Uint8Array([1]), "main.tex", 1, [warning]);
      store.setPdfData(new Uint8Array([2]), "other.tex", 1);
      expect(
        useDocumentStore.getState().compileDiagnosticsCache.get("main.tex"),
      ).toEqual([warning]);
      store.setCompileError("Undefined control sequence", "main.tex");
      expect(
        useDocumentStore.getState().compileDiagnosticsCache.has("main.tex"),
      ).toBe(false);
      store.setPdfData(new Uint8Array([3]), "main.tex", 2, [warning]);
      expect(
        useDocumentStore.getState().compileErrorCache.has("main.tex"),
      ).toBe(false);
      store.setPdfData(new Uint8Array([4]), "main.tex", 3);
      expect(
        useDocumentStore.getState().compileDiagnosticsCache.has("main.tex"),
      ).toBe(false);
    });

    it("retains located errors from a failed compile instead of stale warnings", () => {
      const store = useDocumentStore.getState();
      const diagnostic = {
        severity: "error" as const,
        message: "Undefined command",
        file: "sections/child.tex",
        line: 12,
      };
      store.setPdfData(new Uint8Array([1]), "main.tex", 1, [
        { severity: "warning", message: "Old warning" },
      ]);
      store.setCompileError("Compilation failed", "main.tex", [diagnostic]);
      expect(
        useDocumentStore.getState().compileDiagnosticsCache.get("main.tex"),
      ).toEqual([diagnostic]);
      expect(
        useDocumentStore.getState().compileErrorCache.get("main.tex"),
      ).toBe("Compilation failed");
    });

    it("setPdfData clears compile error", () => {
      useDocumentStore.setState({ compileError: "some error" });
      useDocumentStore.getState().setPdfData(new Uint8Array([1, 2, 3]));
      const state = useDocumentStore.getState();
      expect(getCurrentPdfBytes()).toEqual(new Uint8Array([1, 2, 3]));
      expect(state.compileError).toBeNull();
    });

    it("records the source generation that was actually compiled", () => {
      useDocumentStore.setState({ contentGeneration: 9 });
      useDocumentStore
        .getState()
        .setPdfData(new Uint8Array([1, 2, 3]), "main.tex", 4);

      expect(
        useDocumentStore.getState().lastCompiledGenerations.get("main.tex"),
      ).toBe(4);
    });

    it("setCompileError stores the error string (regression: Tauri string errors must be preserved)", () => {
      useDocumentStore
        .getState()
        .setCompileError("Compilation failed\n\n! Undefined control sequence.");
      expect(useDocumentStore.getState().compileError).toBe(
        "Compilation failed\n\n! Undefined control sequence.",
      );
    });
  });
});
