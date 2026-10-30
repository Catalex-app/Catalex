export type WorkspaceViewMode = "split" | "editor" | "pdf";
export type WorkspaceContentMode = "editor" | "pdf";
export type ModeTransitionPhase =
  | "idle"
  | "assist_to_direct"
  | "direct_to_assist";

export function shouldShowEditorForProposedChange({
  isWorkspaceChat,
  isRenderableLatex,
  activeFileId,
  workspaceChatRightPanelMode,
  hasActiveFileProposedChange,
  modeTransitionPhase,
}: {
  isWorkspaceChat: boolean;
  isRenderableLatex: boolean;
  activeFileId: string | null;
  workspaceChatRightPanelMode: WorkspaceContentMode;
  hasActiveFileProposedChange: boolean;
  modeTransitionPhase: ModeTransitionPhase;
}) {
  return (
    isWorkspaceChat &&
    modeTransitionPhase === "idle" &&
    isRenderableLatex &&
    !!activeFileId &&
    workspaceChatRightPanelMode === "pdf" &&
    hasActiveFileProposedChange
  );
}
