import { beforeEach, describe, expect, it, vi } from "vitest";
import { advanceAfterGitConflictResolution } from "./git-conflicts";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  state: {
    projectRoot: "/project" as string | null,
    activeFileId: "first.md",
    fileSelectionRevision: 0,
    agentWorkspaceSessionId: null as string | null,
    files: [] as { id: string; relativePath: string }[],
    setActiveFile: vi.fn(),
  },
}));
vi.mock("@/lib/desktop/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: { getState: () => mocks.state },
}));

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.state = {
    projectRoot: "/project",
    activeFileId: "first.md",
    fileSelectionRevision: 0,
    agentWorkspaceSessionId: null,
    files: ["first.md", "second.md", "third.md"].map((path) => ({
      id: path,
      relativePath: path,
    })),
    setActiveFile: vi.fn(),
  };
});

const remaining = (...paths: string[]) => ({
  rebasing: false,
  files: paths.map((path) => ({ path, document_path: path })),
});

describe("Git resolution navigation", () => {
  it("opens the first accessible pending file after the refresh completes", async () => {
    mocks.invoke.mockResolvedValue(
      remaining("unavailable.md", "second.md", "third.md"),
    );
    await advanceAfterGitConflictResolution({ ...mocks.state }, "first.md");
    expect(mocks.state.setActiveFile).toHaveBeenCalledExactlyOnceWith(
      "second.md",
    );
  });

  for (const change of ["file", "project", "workspace"] as const) {
    it(`preserves a ${change} selected while resolution was applying`, async () => {
      const before = { ...mocks.state };
      if (change === "file") {
        mocks.state.activeFileId = "third.md";
        mocks.state.fileSelectionRevision++;
      }
      if (change === "project") mocks.state.projectRoot = "/other-project";
      if (change === "workspace") mocks.state.agentWorkspaceSessionId = "draft";
      await advanceAfterGitConflictResolution(before, "first.md");
      expect(mocks.invoke).not.toHaveBeenCalled();
      expect(mocks.state.setActiveFile).not.toHaveBeenCalled();
    });
  }

  it("preserves navigation made while the conflict refresh is pending", async () => {
    let finish!: (value: ReturnType<typeof remaining>) => void;
    mocks.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = advanceAfterGitConflictResolution(
      { ...mocks.state },
      "first.md",
    );
    expect(mocks.state.setActiveFile).not.toHaveBeenCalled();
    mocks.state.activeFileId = "third.md";
    mocks.state.fileSelectionRevision++;
    finish(remaining("second.md"));
    await pending;
    expect(mocks.state.setActiveFile).not.toHaveBeenCalled();
  });

  it("stays on the last file when no conflicts remain", async () => {
    mocks.invoke.mockResolvedValue(remaining());
    await advanceAfterGitConflictResolution({ ...mocks.state }, "first.md");
    expect(mocks.state.setActiveFile).not.toHaveBeenCalled();
  });

  it("advances after disk refresh removes the resolved file and selects a fallback", async () => {
    const before = { ...mocks.state };
    mocks.state.files = mocks.state.files.filter(
      (file) => file.id !== "first.md",
    );
    mocks.state.activeFileId = "third.md";
    mocks.invoke.mockResolvedValue(remaining("second.md"));
    await advanceAfterGitConflictResolution(before, "first.md");
    expect(mocks.state.setActiveFile).toHaveBeenCalledExactlyOnceWith(
      "second.md",
    );
  });

  it("preserves an explicit selection even when the user switches back", async () => {
    const before = { ...mocks.state };
    mocks.state.fileSelectionRevision += 2;
    await advanceAfterGitConflictResolution(before, "first.md");
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.state.setActiveFile).not.toHaveBeenCalled();
  });

  it("stays when the resolved path has a conflict again", async () => {
    mocks.invoke.mockResolvedValue(remaining("first.md", "second.md"));
    await advanceAfterGitConflictResolution({ ...mocks.state }, "first.md");
    expect(mocks.state.setActiveFile).not.toHaveBeenCalled();
  });

  it("stays when the remaining conflicts cannot be refreshed", async () => {
    mocks.invoke.mockRejectedValue(new Error("service disconnected"));
    await advanceAfterGitConflictResolution({ ...mocks.state }, "first.md");
    expect(mocks.state.setActiveFile).not.toHaveBeenCalled();
  });
});
