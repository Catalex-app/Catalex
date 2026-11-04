import {
  WorkspacePanel,
  WorkspacePanelHeader,
  type WorkspacePanelExpansion,
} from "../workspace/workspace-panel";
import type { ReactNode } from "react";
import { AgentDraftNotice } from "./agent-question-prompt";
import { ChatComposer } from "./chat-composer";
import { ChatMessages } from "./chat-messages";
import { ChatTabBar } from "./chat-tab-bar";

export function ChatWorkspacePane({
  expansion,
  title = "Chat",
  displayControl,
  showTabBar = true,
  composerTransferPhase = "idle",
  forceHideComposer = false,
  acceptPendingAttachments = true,
}: {
  expansion?: WorkspacePanelExpansion;
  title?: ReactNode;
  displayControl?: ReactNode;
  showTabBar?: boolean;
  composerTransferPhase?:
    | "idle"
    | "panel_exit"
    | "panel_tv_exit"
    | "panel_enter_prep"
    | "panel_enter";
  forceHideComposer?: boolean;
  acceptPendingAttachments?: boolean;
}) {
  return (
    <WorkspacePanel
      expansion={expansion}
      data-workspace-panel-screen="true"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-panel border border-border/70 bg-card"
    >
      {expansion && (
        <WorkspacePanelHeader>
          <span className="flex min-w-0 flex-1 items-center px-1 font-medium text-sm">
            {title}
          </span>
        </WorkspacePanelHeader>
      )}
      {showTabBar ? <ChatTabBar /> : null}
      <div
        data-chat-messages
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        <ChatMessages />
      </div>
      {displayControl && (
        <div className="flex shrink-0 justify-center px-3 pt-1">
          {displayControl}
        </div>
      )}
      <div
        data-chat-composer-shell="true"
        data-composer-transfer-phase={composerTransferPhase}
        className="shrink-0"
        style={{
          opacity: forceHideComposer
            ? 0
            : composerTransferPhase === "panel_enter_prep"
              ? 0
              : 1,
          transform: forceHideComposer
            ? "translate3d(0, 105%, 0)"
            : composerTransferPhase === "panel_enter_prep"
              ? "translate3d(0, 105%, 0)"
              : composerTransferPhase === "panel_tv_exit"
                ? "translate3d(0, 0, 0)"
                : composerTransferPhase === "panel_exit"
                  ? "translate3d(0, 105%, 0) scaleX(0.9) scaleY(1.14)"
                  : "translate3d(0, 0, 0)",
          transformOrigin:
            composerTransferPhase === "panel_tv_exit" ? "50% 50%" : "50% 100%",
          transition:
            composerTransferPhase === "panel_enter"
              ? "transform 210ms cubic-bezier(0.18, 1.15, 0.24, 1), opacity 170ms cubic-bezier(0.18, 0.9, 0.24, 1)"
              : composerTransferPhase === "panel_exit"
                ? "none"
                : "none",
          animation:
            composerTransferPhase === "panel_exit"
              ? "composer-rush-exit-panel 190ms both linear"
              : composerTransferPhase === "panel_tv_exit"
                ? "workspace-drawer-tv-off 220ms both cubic-bezier(0.55, 0.06, 0.68, 0.19)"
                : "none",
          pointerEvents: forceHideComposer
            ? "none"
            : composerTransferPhase === "panel_enter_prep" ||
                composerTransferPhase === "panel_exit" ||
                composerTransferPhase === "panel_tv_exit"
              ? "none"
              : undefined,
        }}
      >
        <AgentDraftNotice />
        <ChatComposer
          isOpen
          isExpanded
          acceptPendingAttachments={acceptPendingAttachments}
        />
      </div>
    </WorkspacePanel>
  );
}
