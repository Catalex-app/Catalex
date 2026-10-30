import { describe, expect, it } from "vitest";
import { shouldShowEditorForProposedChange } from "./workspace-layout-state";

describe("shouldShowEditorForProposedChange", () => {
  it("switches workspace chat from PDF to editor when the active TeX file has a proposed change", () => {
    expect(
      shouldShowEditorForProposedChange({
        isWorkspaceChat: true,
        isRenderableLatex: true,
        activeFileId: "main.tex",
        workspaceChatRightPanelMode: "pdf",
        hasActiveFileProposedChange: true,
        modeTransitionPhase: "idle",
      }),
    ).toBe(true);
  });

  it("does not switch outside idle workspace chat PDF state", () => {
    expect(
      shouldShowEditorForProposedChange({
        isWorkspaceChat: false,
        isRenderableLatex: true,
        activeFileId: "main.tex",
        workspaceChatRightPanelMode: "pdf",
        hasActiveFileProposedChange: true,
        modeTransitionPhase: "idle",
      }),
    ).toBe(false);

    expect(
      shouldShowEditorForProposedChange({
        isWorkspaceChat: true,
        isRenderableLatex: true,
        activeFileId: "main.tex",
        workspaceChatRightPanelMode: "editor",
        hasActiveFileProposedChange: true,
        modeTransitionPhase: "idle",
      }),
    ).toBe(false);

    expect(
      shouldShowEditorForProposedChange({
        isWorkspaceChat: true,
        isRenderableLatex: true,
        activeFileId: "main.tex",
        workspaceChatRightPanelMode: "pdf",
        hasActiveFileProposedChange: true,
        modeTransitionPhase: "assist_to_direct",
      }),
    ).toBe(false);
  });
});
