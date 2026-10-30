import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPdfBytesCache,
  getCurrentPdfBytes,
  useDocumentStore,
} from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { compileLatex } from "@/lib/latex-compiler";
import {
  beginCompilation,
  captureCompileContext,
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
