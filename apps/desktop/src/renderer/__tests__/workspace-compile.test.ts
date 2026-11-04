import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPdfBytesCache,
  getCurrentPdfBytes,
  useDocumentStore,
} from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { invoke } from "@/lib/desktop/core";
import { compileLatex } from "@/lib/latex-compiler";
import {
  beginCompilation,
  captureCompileContext,
  captureAutomaticCompileContext,
  stopCompilation,
  compileWorkspace,
  failCompilation,
  finishCompilation,
  publishCompilation,
} from "@/lib/workspace-compile";

vi.mock("@/lib/mupdf/pdf-doc-cache", () => ({
  prepareForNewPdfRevision: vi.fn(),
}));
vi.mock("@/lib/latex-compiler", async (original) => ({
  ...(await original<object>()),
  compileLatex: vi.fn(),
}));
vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: () => ({
      stopReview: vi.fn(),
      createSnapshot: vi.fn(async () => {}),
    }),
  },
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const bytes = new Uint8Array([1, 2, 3]);
const result = {
  pdfData: bytes,
  diagnostics: [{ severity: "warning" as const, message: "old warning" }],
};
const initial = useDocumentStore.getState();
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useSettingsStore.setState({
    defaultAutoCompile: true,
    autoCompileByProject: {},
  });
  useDocumentStore.setState(initial, true);
  clearPdfBytesCache();
  useDocumentStore.setState({
    projectRoot: "/one",
    activeFileId: "main.tex",
    initialized: true,
    files: [
      {
        id: "main.tex",
        name: "main.tex",
        relativePath: "main.tex",
        absolutePath: "/one/main.tex",
        type: "tex",
        content: "\\documentclass{article}",
        isDirty: false,
      },
    ],
    saveAllFiles: vi.fn(async () => {}),
  });
});
afterEach(() => vi.useRealTimers());

describe("workspace compile ownership", () => {
  const switches = {
    project: () => useDocumentStore.setState({ projectRoot: "/two" }),
    "project away and back": () => {
      useDocumentStore.setState({ projectRoot: "/two" });
      useDocumentStore.setState({ projectRoot: "/one" });
    },
    draft: () =>
      useDocumentStore.setState({
        agentWorkspaceRoot: "/draft",
        agentWorkspaceSessionId: "draft",
      }),
    "draft away and back": () => {
      useDocumentStore.setState({ agentWorkspaceRoot: "/draft" });
      useDocumentStore.setState({ agentWorkspaceRoot: null });
    },
    source: () =>
      useDocumentStore.setState({
        files: [
          ...useDocumentStore.getState().files,
          {
            ...useDocumentStore.getState().files[0],
            id: "other.tex",
            name: "other.tex",
            relativePath: "other.tex",
          },
        ],
        activeFileId: "other.tex",
      }),
    edit: () =>
      useDocumentStore.getState().updateFileContent("main.tex", "new source"),
    "Git/rewind starts": () =>
      useDocumentStore.setState({ isGitOperationRunning: true }),
    "Git/rewind reconciliation": () =>
      useDocumentStore.setState({ contentGeneration: 1 }),
    close: () => useDocumentStore.setState({ projectRoot: null }),
  };
  for (const [name, change] of Object.entries(switches)) {
    for (const outcome of ["success", "failure"]) {
      it(`ignores delayed ${outcome} after ${name}`, async () => {
        const pending = deferred<typeof result>();
        vi.mocked(compileLatex).mockReturnValueOnce(pending.promise);
        const run = compileWorkspace({ force: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(compileLatex).toHaveBeenCalledTimes(1);
        change();
        expect(useDocumentStore.getState().isCompiling).toBe(
          name === "edit" || name === "Git/rewind reconciliation",
        );
        if (outcome === "success") pending.resolve(result);
        else
          pending.reject({
            message: "old failure",
            diagnostics: result.diagnostics,
          });
        await run;
        expect(getCurrentPdfBytes()).toBeNull();
        expect(useDocumentStore.getState().compileError).toBeNull();
        expect(useDocumentStore.getState().compileDiagnosticsCache.size).toBe(
          0,
        );
        expect(useDocumentStore.getState().lastCompiledGenerations.size).toBe(
          0,
        );
      });
    }
  }
  it("does not start the compiler when the workspace changes during save", async () => {
    const save = deferred<void>();
    useDocumentStore.setState({ saveAllFiles: () => save.promise });
    const run = compileWorkspace({ force: true });
    useDocumentStore.setState({ projectRoot: "/two" });
    save.resolve();
    await run;
    expect(compileLatex).not.toHaveBeenCalled();
  });
  it.each([
    "success",
    "failure",
  ])("preserves the request when editing during a delayed save (%s)", async (outcome) => {
    const save = deferred<void>();
    useDocumentStore.setState({
      saveAllFiles: vi
        .fn()
        .mockReturnValueOnce(save.promise)
        .mockResolvedValue(undefined),
    });
    vi.mocked(compileLatex).mockResolvedValueOnce(result);
    const run = compileWorkspace({ force: true });
    useDocumentStore
      .getState()
      .updateFileContent(
        "main.tex",
        "\\documentclass{article} edited during save",
      );
    if (outcome === "success") save.resolve();
    else save.reject(new Error("The document changed while saving"));
    await run;
    await vi.advanceTimersByTimeAsync(500);
    expect(compileLatex).toHaveBeenCalledTimes(1);
    expect(useDocumentStore.getState().saveAllFiles).toHaveBeenCalledTimes(2);
    expect(
      useDocumentStore.getState().lastCompiledGenerations.get("main.tex"),
    ).toBe(useDocumentStore.getState().contentGeneration);
    expect(useDocumentStore.getState().compileError).toBeNull();
  });
  it("coalesces requests for the new workspace behind the running build", async () => {
    const oldResult = deferred<typeof result>();
    const latest = deferred<typeof result>();
    vi.mocked(compileLatex)
      .mockReturnValueOnce(oldResult.promise)
      .mockReturnValueOnce(latest.promise);
    const old = compileWorkspace({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    useDocumentStore.setState({ projectRoot: "/two" });
    await compileWorkspace({ force: true });
    await compileWorkspace({ force: true });
    expect(compileLatex).toHaveBeenCalledTimes(1);
    oldResult.resolve(result);
    await old;
    await vi.advanceTimersByTimeAsync(0);
    expect(useDocumentStore.getState().isCompiling).toBe(true);
    expect(useDocumentStore.getState().pendingRecompile).toBe(false);
    latest.resolve(result);
    await vi.advanceTimersByTimeAsync(500);
    expect(compileLatex).toHaveBeenCalledTimes(2);
    expect(useDocumentStore.getState().isCompiling).toBe(false);
  });
  it.each([
    false,
    true,
  ])("preserves a manual retry through edits (additional automatic request: %s)", async (automatic) => {
    const pending = deferred<typeof result>();
    vi.mocked(compileLatex)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(result);
    const run = compileWorkspace({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    await compileWorkspace({ force: true, snapshot: true });
    useDocumentStore
      .getState()
      .updateFileContent("main.tex", "\\documentclass{article} latest");
    if (automatic) await compileWorkspace();
    expect(compileLatex).toHaveBeenCalledTimes(1);
    expect(useDocumentStore.getState().pendingRecompile).toBe(true);
    pending.resolve(result);
    await run;
    await vi.advanceTimersByTimeAsync(500);
    expect(compileLatex).toHaveBeenCalledTimes(2);
    expect(
      useDocumentStore.getState().lastCompiledGenerations.get("main.tex"),
    ).toBe(useDocumentStore.getState().contentGeneration);
    expect(useDocumentStore.getState().saveAllFiles).toHaveBeenCalledTimes(2);
  });
  it("keeps a queued manual retry when switching between files with the same root", async () => {
    useDocumentStore.setState({
      files: [
        ...useDocumentStore.getState().files,
        {
          ...useDocumentStore.getState().files[0],
          id: "chapter.tex",
          name: "chapter.tex",
          relativePath: "chapter.tex",
          content: "% !TEX root = main.tex\nChapter",
        },
      ],
    });
    const pending = deferred<typeof result>();
    vi.mocked(compileLatex)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(result);
    const run = compileWorkspace({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    await compileWorkspace({ force: true });
    const scheduled = captureCompileContext();
    useDocumentStore.setState({ activeFileId: "chapter.tex" });
    expect(scheduled()).toBe(true);
    expect(useDocumentStore.getState().pendingRecompile).toBe(true);
    pending.resolve(result);
    await run;
    await vi.advanceTimersByTimeAsync(500);
    expect(compileLatex).toHaveBeenCalledTimes(2);
  });
  it.each([
    "project",
    "source",
  ] as const)("drops an old queued retry and delayed auto-compile on a %s switch", async (target) => {
    const pending = deferred<typeof result>();
    vi.mocked(compileLatex).mockReturnValueOnce(pending.promise);
    const run = compileWorkspace({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    await compileWorkspace({ force: true });
    const scheduled = captureCompileContext();
    switches[target]();
    pending.resolve(result);
    await run;
    await vi.advanceTimersByTimeAsync(1000);
    expect(scheduled()).toBe(false);
    expect(compileLatex).toHaveBeenCalledTimes(1);
    expect(useDocumentStore.getState().pendingRecompile).toBe(false);
  });
  it("starts the pending retry after the old compiler fails without publishing its error", async () => {
    const pending = deferred<typeof result>();
    vi.mocked(compileLatex)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(result);
    const run = compileWorkspace({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    await compileWorkspace({ force: true });
    pending.reject(new Error("obsolete failure"));
    await run;
    await vi.advanceTimersByTimeAsync(500);
    expect(compileLatex).toHaveBeenCalledTimes(2);
    expect(useDocumentStore.getState().compileError).toBeNull();
    expect(getCurrentPdfBytes()).toEqual(bytes);
  });
  it("preserves a pending user retry when another verification starts", async () => {
    const old = beginCompilation("main.tex")!;
    await compileWorkspace({ force: true });
    const current = beginCompilation("main.tex")!;
    expect(useDocumentStore.getState().pendingRecompile).toBe(true);
    finishCompilation(old);
    vi.mocked(compileLatex).mockResolvedValueOnce(result);
    finishCompilation(current);
    await vi.advanceTimersByTimeAsync(500);
    expect(compileLatex).toHaveBeenCalledTimes(1);
    expect(getCurrentPdfBytes()).toEqual(bytes);
  });
  it("waits for the local build when an overlapping verification finishes first", async () => {
    const pending = deferred<typeof result>();
    vi.mocked(compileLatex)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(result);
    const run = compileWorkspace({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    const verification = beginCompilation("main.tex")!;
    await compileWorkspace({ force: true });
    finishCompilation(verification);
    expect(compileLatex).toHaveBeenCalledTimes(1);
    expect(useDocumentStore.getState().isCompiling).toBe(true);
    pending.resolve(result);
    await run;
    await vi.advanceTimersByTimeAsync(500);
    expect(compileLatex).toHaveBeenCalledTimes(2);
    expect(useDocumentStore.getState().isCompiling).toBe(false);
    expect(getCurrentPdfBytes()).toEqual(bytes);
  });
  it("reports a genuine save failure without endlessly retrying", async () => {
    useDocumentStore.setState({
      saveAllFiles: vi.fn().mockRejectedValue(new Error("Disk is full")),
    });
    const run = compileWorkspace({ force: true });
    await vi.advanceTimersByTimeAsync(1000);
    await run;
    expect(compileLatex).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().saveAllFiles).toHaveBeenCalledTimes(1);
    expect(useDocumentStore.getState().compileError).toBe("Disk is full");
    expect(useDocumentStore.getState().isCompiling).toBe(false);
    expect(useDocumentStore.getState().pendingRecompile).toBe(false);
  });
  it("agent and user requests share publication and cleanup ownership", () => {
    const old = beginCompilation("main.tex")!;
    const current = beginCompilation("main.tex")!;
    publishCompilation(old, bytes, result.diagnostics);
    failCompilation(old, "old");
    finishCompilation(old);
    expect(getCurrentPdfBytes()).toBeNull();
    expect(useDocumentStore.getState().compileError).toBeNull();
    expect(useDocumentStore.getState().isCompiling).toBe(true);
    publishCompilation(current, bytes, result.diagnostics);
    finishCompilation(current);
    expect(getCurrentPdfBytes()).toEqual(bytes);
    expect(
      useDocumentStore.getState().compileDiagnosticsCache.get("main.tex"),
    ).toEqual(result.diagnostics);
  });
});

describe("automatic compile preference", () => {
  it("blocks automatic requests while keeping manual compilation available", async () => {
    useSettingsStore.getState().setProjectAutoCompile("/one", false);
    await compileWorkspace({ force: true, automatic: true });
    expect(compileLatex).not.toHaveBeenCalled();
    vi.mocked(compileLatex).mockResolvedValueOnce(result);
    const run = compileWorkspace({ force: true });
    await vi.advanceTimersByTimeAsync(500);
    await run;
    expect(compileLatex).toHaveBeenCalledTimes(1);
  });

  it("does not launch an automatic compiler after switching off during a save", async () => {
    const save = deferred<void>();
    useDocumentStore.setState({ saveAllFiles: () => save.promise });
    const run = compileWorkspace({ force: true, automatic: true });
    useDocumentStore.getState().updateFileContent("main.tex", "later edit");
    useSettingsStore.getState().setProjectAutoCompile("/one", false);
    save.resolve();
    await vi.advanceTimersByTimeAsync(500);
    await run;
    expect(compileLatex).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().pendingRecompile).toBe(false);
    expect(useDocumentStore.getState().isCompiling).toBe(false);
  });

  it.each([
    false,
    true,
  ])("drops queued auto work while preserving a manual retry: %s", async (manualRetry) => {
    const pending = deferred<typeof result>();
    vi.mocked(compileLatex)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(result);
    const run = compileWorkspace({ force: true, automatic: true });
    await vi.advanceTimersByTimeAsync(0);
    await compileWorkspace({ force: true, automatic: true });
    if (manualRetry) await compileWorkspace({ force: true });
    // A later automatic request must not turn a manual retry into automatic work.
    await compileWorkspace({ force: true, automatic: true });
    expect(useDocumentStore.getState().pendingRecompile).toBe(true);
    useSettingsStore.getState().setProjectAutoCompile("/one", false);
    expect(useDocumentStore.getState().pendingRecompile).toBe(manualRetry);
    pending.resolve(result);
    await run;
    await vi.advanceTimersByTimeAsync(1000);
    expect(compileLatex).toHaveBeenCalledTimes(manualRetry ? 2 : 1);
    expect(useDocumentStore.getState().isCompiling).toBe(false);
  });
});

it("does not cancel the current project's retry when defaults or another project change", async () => {
  const pending = deferred<typeof result>();
  vi.mocked(compileLatex)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(result);
  const run = compileWorkspace({ force: true, automatic: true });
  await vi.advanceTimersByTimeAsync(0);
  await compileWorkspace({ force: true, automatic: true });
  useSettingsStore.getState().setDefaultAutoCompile(false);
  useSettingsStore.getState().setProjectAutoCompile("/two", false);
  expect(useDocumentStore.getState().pendingRecompile).toBe(true);
  pending.resolve(result);
  await run;
  await vi.advanceTimersByTimeAsync(1000);
  expect(compileLatex).toHaveBeenCalledTimes(2);
});

describe("manual compilation cancellation", () => {
  it("clears queued work, ignores cancelled output, and waits for native cleanup", async () => {
    useDocumentStore
      .getState()
      .setPdfData(bytes, "main.tex", 0, result.diagnostics);
    const compile = deferred<typeof result>();
    const cleanup = deferred<void>();
    vi.mocked(compileLatex).mockReturnValueOnce(compile.promise);
    vi.mocked(invoke).mockReturnValueOnce(cleanup.promise);
    const run = compileWorkspace({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    await compileWorkspace({ force: true });
    const beforeStop = captureAutomaticCompileContext();
    const stop = stopCompilation();
    expect(beforeStop()).toBe(false);
    expect(captureAutomaticCompileContext()()).toBe(true);
    expect(useDocumentStore.getState().pendingRecompile).toBe(false);
    expect(useDocumentStore.getState().isStoppingCompilation).toBe(true);
    expect(invoke).toHaveBeenCalledWith("cancel_compilation", {
      projectDir: "/one",
      compilationIds: [vi.mocked(compileLatex).mock.calls[0][5]],
    });
    compile.resolve({ pdfData: new Uint8Array([9]), diagnostics: [] });
    await run;
    expect(useDocumentStore.getState().isStoppingCompilation).toBe(true);
    expect(getCurrentPdfBytes()).toEqual(bytes);
    expect(
      useDocumentStore.getState().compileDiagnosticsCache.get("main.tex"),
    ).toEqual(result.diagnostics);
    cleanup.resolve();
    await stop;
    expect(useDocumentStore.getState().isCompiling).toBe(false);
    expect(useDocumentStore.getState().isStoppingCompilation).toBe(false);
    expect(compileLatex).toHaveBeenCalledTimes(1);
  });

  it("does not revive a cancelled request after a save-time edit", async () => {
    const save = deferred<void>();
    useDocumentStore.setState({ saveAllFiles: () => save.promise });
    const run = compileWorkspace({ force: true });
    useDocumentStore
      .getState()
      .updateFileContent("main.tex", "edited during save");
    const stop = stopCompilation();
    save.resolve();
    await Promise.all([run, stop]);
    expect(compileLatex).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("cancel_compilation", {
      projectDir: "/one",
      compilationIds: [],
    });
    expect(useDocumentStore.getState().isCompiling).toBe(false);
  });

  it("coalesces new requests after Stop and runs them only after cleanup", async () => {
    const compile = deferred<typeof result>();
    const cleanup = deferred<void>();
    vi.mocked(compileLatex)
      .mockReturnValueOnce(compile.promise)
      .mockResolvedValue(result);
    vi.mocked(invoke).mockReturnValueOnce(cleanup.promise);
    const run = compileWorkspace({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    const stop = stopCompilation();
    await compileWorkspace({ force: true });
    await compileWorkspace({ force: true });
    compile.reject({ code: "cancelled", message: "Compilation cancelled" });
    await run;
    expect(compileLatex).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await stop;
    await vi.advanceTimersByTimeAsync(500);
    expect(compileLatex).toHaveBeenCalledTimes(2);
    expect(useDocumentStore.getState().compileError).toBeNull();
    expect(useDocumentStore.getState().isCompiling).toBe(false);
  });

  it("cancels overlapping verification requests by ID without publishing their results", async () => {
    const first = beginCompilation("main.tex", "verification-one")!;
    const second = beginCompilation("main.tex", "verification-two")!;
    vi.mocked(invoke).mockResolvedValueOnce(null);
    const stop = stopCompilation();
    expect(invoke).toHaveBeenCalledWith("cancel_compilation", {
      projectDir: "/one",
      compilationIds: ["verification-one", "verification-two"],
    });
    publishCompilation(first, bytes);
    publishCompilation(second, bytes);
    finishCompilation(second);
    expect(useDocumentStore.getState().isStoppingCompilation).toBe(true);
    finishCompilation(first);
    await stop;
    expect(getCurrentPdfBytes()).toBeNull();
    expect(useDocumentStore.getState().isCompiling).toBe(false);
  });

  it("keeps new workspace state when stopped work finishes late", async () => {
    const old = beginCompilation("main.tex", "old-verification")!;
    const cleanup = deferred<void>();
    vi.mocked(invoke).mockReturnValueOnce(cleanup.promise);
    const stop = stopCompilation();
    useDocumentStore.setState({ projectRoot: "/two" });
    const current = beginCompilation("main.tex", "new-verification")!;
    finishCompilation(old);
    cleanup.resolve();
    await stop;
    expect(useDocumentStore.getState().isCompiling).toBe(true);
    expect(useDocumentStore.getState().isStoppingCompilation).toBe(false);
    publishCompilation(current, bytes);
    finishCompilation(current);
    expect(getCurrentPdfBytes()).toEqual(bytes);
  });
});

it("keeps automatic requests paused for unchanged source after preview remount", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  await stopCompilation();
  await compileWorkspace({ force: true, automatic: true });
  expect(compileLatex).not.toHaveBeenCalled();
  useDocumentStore
    .getState()
    .updateFileContent("main.tex", "fresh edit after Stop");
  vi.mocked(compileLatex).mockResolvedValueOnce(result);
  const run = compileWorkspace({ automatic: true });
  await vi.advanceTimersByTimeAsync(500);
  await run;
  expect(compileLatex).toHaveBeenCalledTimes(1);
});

it("resumes automatic compilation after an explicit compiler setting change", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  await stopCompilation();
  await compileWorkspace({ force: true, automatic: true });
  expect(compileLatex).not.toHaveBeenCalled();
  useSettingsStore.getState().setCompilerChoiceForRoot("/one", "main.tex", {
    backend: "tectonic",
    engine: "pdflatex",
    autoEngine: false,
  });
  vi.mocked(compileLatex).mockResolvedValueOnce(result);
  const run = compileWorkspace({ force: true, automatic: true });
  await vi.advanceTimersByTimeAsync(500);
  await run;
  expect(compileLatex).toHaveBeenCalledTimes(1);
});

it("publishes a pinned panel's root without changing the main window's selected file", async () => {
  const primary = useDocumentStore.getState().files[0];
  useDocumentStore.setState({
    files: [
      primary,
      {
        ...primary,
        id: "other.tex",
        name: "other.tex",
        relativePath: "other.tex",
      },
    ],
    activeFileId: "other.tex",
  });
  const pending = deferred<typeof result>();
  vi.mocked(compileLatex).mockReturnValueOnce(pending.promise);
  const run = compileWorkspace({ force: true, fileId: "main.tex" });
  await vi.advanceTimersByTimeAsync(0);
  expect(compileLatex).toHaveBeenCalledTimes(1);
  useDocumentStore.setState({ activeFileId: "main.tex" });
  useDocumentStore.setState({ activeFileId: "other.tex" });
  pending.resolve(result);
  await vi.runAllTimersAsync();
  await run;
  expect(useDocumentStore.getState().activeFileId).toBe("other.tex");
  expect(
    useDocumentStore.getState().lastCompiledGenerations.get("main.tex"),
  ).toBe(0);
  expect(getCurrentPdfBytes()).toBeNull();
  useDocumentStore.getState().setActiveFile("main.tex");
  expect(getCurrentPdfBytes()).toBe(bytes);
});

it("coalesces automatic requests for the same root from two views", async () => {
  const pending = deferred<typeof result>();
  vi.mocked(compileLatex).mockReturnValueOnce(pending.promise);
  const first = compileWorkspace({ force: true, automatic: true });
  await vi.advanceTimersByTimeAsync(0);
  await compileWorkspace({ force: true, automatic: true, fileId: "main.tex" });
  pending.resolve(result);
  await vi.runAllTimersAsync();
  await first;
  expect(compileLatex).toHaveBeenCalledTimes(1);
  expect(getCurrentPdfBytes()).toBe(bytes);
});
