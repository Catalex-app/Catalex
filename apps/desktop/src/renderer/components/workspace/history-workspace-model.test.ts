import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import {
  getHistoryRestoreBlockReason,
  labelValidationReason,
  snapshotAutomaticLabels,
} from "./history-workspace-model";

const initialDocument = useDocumentStore.getState();
const initialAgent = useAgentChatStore.getState();
const initialProposed = useProposedChangesStore.getState();
const file: ProjectFile = {
  id: "main.tex",
  name: "main.tex",
  relativePath: "main.tex",
  absolutePath: "/project/main.tex",
  type: "tex",
  isDirty: true,
  content: "Unsaved text",
};

function resetStores() {
  useDocumentStore.setState(initialDocument, true);
  useAgentChatStore.setState(initialAgent, true);
  useProposedChangesStore.setState(initialProposed, true);
}

describe("history restore availability", () => {
  beforeEach(() => {
    resetStores();
    useDocumentStore.setState({ projectRoot: "/project", files: [file] });
    useAgentChatStore.setState({ tabs: [], isStreaming: false });
    useProposedChangesStore.setState({ changes: [], workspaceReview: null });
  });
  afterEach(resetStores);

  it("allows ordinary unsaved buffers, which the restore transaction saves", () => {
    expect(getHistoryRestoreBlockReason()).toBeNull();
  });

  it("checks background tabs and allows restoration once settlement finishes", () => {
    const active = {
      ...initialAgent.tabs[0],
      id: "active",
      isStreaming: false,
    };
    const background = { ...active, id: "background", isStreaming: true };
    useAgentChatStore.setState({
      tabs: [active, background],
      isStreaming: false,
    });
    expect(getHistoryRestoreBlockReason()).toMatch(/agent to finish/);
    useAgentChatStore.setState({
      tabs: [active, { ...background, isStreaming: false, isSettling: true }],
    });
    expect(getHistoryRestoreBlockReason()).toMatch(/agent to finish/);
    useAgentChatStore.setState({ tabs: [active] });
    expect(getHistoryRestoreBlockReason()).toBeNull();
  });

  it("keeps restoration blocked after the last decision until review settles", () => {
    useProposedChangesStore.setState({
      workspaceReview: {
        session: {
          version: 2,
          sessionId: "review",
          projectRoot: "/project",
          tabId: "background",
          mode: "edit",
          status: "review",
          createdAt: 0,
          updatedAt: 0,
          sourceCommit: "fixture-source",
          baselineCommit: "fixture-baseline",
          candidateRoot: "/draft/candidate",
          warnings: [],
        },
        originalChanges: [],
        decisions: {},
        settlementError: "Source changed",
      },
    });
    expect(getHistoryRestoreBlockReason()).toMatch(/pending agent changes/);
    useProposedChangesStore.setState({ workspaceReview: null });
    expect(getHistoryRestoreBlockReason()).toBeNull();
  });

  it("blocks unresolved proposed changes even outside an agent workspace", () => {
    useProposedChangesStore.setState({
      changes: [
        {
          id: "edit",
          filePath: "main.tex",
          absolutePath: "/project/main.tex",
          oldContent: "Before",
          newContent: "After",
          toolName: "Edit",
          timestamp: 0,
        },
      ],
    });
    expect(getHistoryRestoreBlockReason()).toMatch(/pending agent changes/);
  });

  it("rechecks source availability and in-flight operations at confirmation", () => {
    expect(getHistoryRestoreBlockReason()).toBeNull();
    useDocumentStore.setState({ isGitOperationRunning: true });
    expect(getHistoryRestoreBlockReason()).toMatch(/Git operation/);
    useDocumentStore.setState({
      isGitOperationRunning: false,
      isApplyingAgentDraft: true,
    });
    expect(getHistoryRestoreBlockReason()).toMatch(/finish applying/);
    useDocumentStore.setState({
      isApplyingAgentDraft: false,
      agentWorkspaceRoot: "/draft",
    });
    expect(getHistoryRestoreBlockReason()).toMatch(/project workspace/);
    useDocumentStore.setState({
      agentWorkspaceRoot: null,
      isAgentWorkspaceReadOnly: true,
    });
    expect(getHistoryRestoreBlockReason()).toMatch(/project workspace/);
    useDocumentStore.setState({
      isAgentWorkspaceReadOnly: false,
      projectRoot: null,
    });
    expect(getHistoryRestoreBlockReason()).toMatch(/Open a project/);
  });

  it("requires resolving disk conflicts even when a buffer is clean", () => {
    useDocumentStore.setState({
      files: [
        {
          ...file,
          isDirty: false,
          externalChange: { id: "disk", base: "Before", disk: "External edit" },
        },
      ],
    });
    expect(getHistoryRestoreBlockReason()).toMatch(/changed on disk/);
  });
});

describe("label validation", () => {
  it("reserves exact Agent but allows case variants and reuse on other checkpoints", () => {
    expect(labelValidationReason(" Agent ")).toBe("Reserved label");
    expect(labelValidationReason("agent")).toBeNull();
    expect(labelValidationReason("AGENT")).toBeNull();
    expect(labelValidationReason(" Draft ", ["Draft"])).toBe("Already added");
    expect(labelValidationReason("Draft", ["Other"])).toBeNull();
  });
  it("matches native UTF-8 length and control character rules", () => {
    expect(labelValidationReason(" ")).toBe("Enter a label");
    expect(labelValidationReason("初".repeat(85))).toBeNull();
    expect(labelValidationReason("初".repeat(86))).toBe("Label is too long");
    expect(labelValidationReason("a\u0000b")).toBe("Invalid label");
  });
});

it("classifies comment checkpoints by the triggering actor", () => {
  expect(
    snapshotAutomaticLabels({ message: "[comments] Before clearing comments" }),
  ).toEqual(["Comments"]);
  expect(
    snapshotAutomaticLabels({
      message: "[agent-comments] First comment on main.tex",
    }),
  ).toEqual(["Agent", "Comments"]);
  expect(labelValidationReason("Comments")).toBe("Reserved label");
  expect(labelValidationReason("comments")).toBeNull();
});
