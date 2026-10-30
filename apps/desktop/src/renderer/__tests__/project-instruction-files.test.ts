import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";

function activeFile() {
  const state = useDocumentStore.getState();
  return state.files.find((file) => file.id === state.activeFileId);
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  useSettingsStore.getState().setGlobalAgentPrompt("Initial Global");
  useDocumentStore.setState({
    projectRoot: "/project",
    agentWorkspaceRoot: null,
    isApplyingAgentDraft: false,
    isAgentWorkspaceReadOnly: false,
    isGitOperationRunning: false,
    activeFileId: "main.tex",
    openFileIds: ["main.tex"],
    files: [
      {
        id: "main.tex",
        name: "main.tex",
        relativePath: "main.tex",
        absolutePath: "/project/main.tex",
        type: "tex",
        content: "Project source",
        isDirty: false,
      },
    ],
  });
  vi.mocked(invoke).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("project instruction files", () => {
  it.each([
    "AGENTS.md",
    "CLAUDE.md",
  ] as const)("creates %s as an ordinary Markdown project file", async (fileName) => {
    vi.mocked(invoke).mockResolvedValueOnce({ written: true, current: "" });
    await useDocumentStore.getState().openProjectInstructionFile(fileName);
    expect(invoke).toHaveBeenCalledWith("save_file_if_unchanged", {
      projectRoot: "/project",
      filePath: fileName,
      expected: null,
      content: "",
    });
    expect(activeFile()).toMatchObject({
      id: fileName,
      absolutePath: `/project/${fileName}`,
      content: "",
      isDirty: false,
    });
    expect(useSettingsStore.getState().globalAgentPrompt).toBe(
      "Initial Global",
    );
  });

  it("opens an existing file with its unsaved buffer without writing it", async () => {
    useDocumentStore.setState((state) => ({
      files: [
        ...state.files,
        {
          id: "AGENTS.md",
          name: "AGENTS.md",
          relativePath: "AGENTS.md",
          absolutePath: "/project/AGENTS.md",
          type: "other",
          content: "Unsaved instructions",
          diskContent: "Saved instructions",
          isDirty: true,
        },
      ],
    }));
    await useDocumentStore.getState().openProjectInstructionFile("AGENTS.md");
    expect(activeFile()?.content).toBe("Unsaved instructions");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("preserves an instruction file that appeared after the missing row rendered", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      written: false,
      current: "Existing instructions",
    });
    await useDocumentStore.getState().openProjectInstructionFile("CLAUDE.md");
    expect(activeFile()).toMatchObject({
      content: "Existing instructions",
      diskContent: "Existing instructions",
      isDirty: false,
    });
  });

  it("does not attach a late creation response to another project", async () => {
    let finish!: (result: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const opening = useDocumentStore
      .getState()
      .openProjectInstructionFile("AGENTS.md");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    useDocumentStore.setState({
      projectRoot: "/different",
      files: [],
      activeFileId: "",
    });
    finish({ written: true, current: "" });
    await opening;
    expect(useDocumentStore.getState().files).toEqual([]);
    expect(useDocumentStore.getState().activeFileId).toBe("");
  });

  it("does not create source instructions during an agent draft", async () => {
    useDocumentStore.setState({ agentWorkspaceRoot: "/draft" });
    await useDocumentStore.getState().openProjectInstructionFile("AGENTS.md");
    expect(invoke).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().files).toHaveLength(1);
  });
});
