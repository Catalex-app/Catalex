import {
  WorkspacePanel,
  WorkspacePanelHeader,
  type WorkspacePanelExpansion,
} from "../workspace/workspace-panel";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { AgentDraftNotice } from "./agent-question-prompt";
import { ChatComposer } from "./chat-composer";
import { ChatMessages } from "./chat-messages";
import { useShallow } from "zustand/react/shallow";
import {
  useAgentChatStore,
  lastCommunicationDetails,
} from "@/stores/agent-chat-store";
import { formatClaudeModelName } from "@/lib/claude-models";
import { formatCodexModelName, codexEffortLabel } from "@/lib/codex-models";
import { piModelLabel } from "@/lib/pi-models";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { usePiSetupStore } from "@/stores/pi-setup-store";

export function ChatWorkspacePane({
  expansion,
  displayControl,
  composerTransferPhase = "idle",
  forceHideComposer = false,
  acceptPendingAttachments = true,
}: {
  expansion?: WorkspacePanelExpansion;
  displayControl?: ReactNode;
  composerTransferPhase?:
    | "idle"
    | "panel_exit"
    | "panel_tv_exit"
    | "panel_enter_prep"
    | "panel_enter";
  forceHideComposer?: boolean;
  acceptPendingAttachments?: boolean;
}) {
  const lastExchange = useAgentChatStore(
    useShallow((s) =>
      lastCommunicationDetails(s.tabs.find((tab) => tab.id === s.activeTabId)),
    ),
  );
  const provider = lastExchange?.provider;
  const selectedProvider = useAgentChatStore((s) => s.selectedProvider);
  // Read existing setup state only. Rendering this label never starts a check.
  const claudeStatus = useClaudeSetupStore((s) =>
    !provider && selectedProvider === "claude" ? s.status : undefined,
  );
  const codexStatus = useCodexSetupStore((s) =>
    !provider && selectedProvider === "codex" ? s.status : undefined,
  );
  const piStatus = usePiSetupStore((s) =>
    !provider && selectedProvider === "pi" ? s.status : undefined,
  );
  const setupStatus = claudeStatus ?? codexStatus ?? piStatus;
  const readiness =
    setupStatus === "checking"
      ? "Checking agent…"
      : setupStatus === "not-authenticated"
        ? "Sign-in required"
        : setupStatus === "disabled" ||
            setupStatus === "not-installed" ||
            setupStatus === "missing-git"
          ? "Setup required"
          : setupStatus === "error"
            ? "Agent unavailable"
            : "Ready";
  const model = lastExchange?.model
    ? provider === "claude"
      ? formatClaudeModelName(lastExchange.model)
      : provider === "pi"
        ? piModelLabel(lastExchange.model)
        : formatCodexModelName(lastExchange.model)
    : undefined;
  const details = [
    model,
    lastExchange?.effort ? codexEffortLabel(lastExchange.effort) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const titleTransitionKey = JSON.stringify([
    provider,
    model,
    lastExchange?.effort,
    provider ? undefined : readiness,
  ]);
  const title = provider ? (
    <span className="flex min-w-0 items-baseline gap-2">
      <span data-chat-last-provider="" className="shrink-0">
        {provider === "claude"
          ? "Claude"
          : provider === "codex"
            ? "Codex"
            : "Pi"}
      </span>
      {details && (
        <span
          data-chat-last-model=""
          className="truncate font-normal text-muted-foreground text-xs"
          title={[lastExchange?.model, lastExchange?.effort]
            .filter(Boolean)
            .join(" · ")}
        >
          {details}
        </span>
      )}
    </span>
  ) : (
    <span data-chat-readiness="" className="flex min-w-0 items-center gap-2">
      <span className="truncate">{readiness}</span>
      <span
        data-chat-readiness-dot=""
        aria-hidden="true"
        className={
          readiness === "Ready"
            ? "size-1.5 shrink-0 rounded-full bg-emerald-500"
            : setupStatus === "error"
              ? "size-1.5 shrink-0 rounded-full bg-red-500"
              : "size-1.5 shrink-0 rounded-full bg-amber-500"
        }
      />
    </span>
  );
  const previousTitle = useRef({ key: titleTransitionKey, title });
  const [outgoingTitle, setOutgoingTitle] = useState<{
    title: ReactNode;
  } | null>(null);
  const currentTitleRef = useRef<HTMLSpanElement>(null);
  const outgoingTitleRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const previous = previousTitle.current;
    previousTitle.current = { key: titleTransitionKey, title };
    if (previous.key === titleTransitionKey) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOutgoingTitle(null);
      return;
    }
    setOutgoingTitle({ title: previous.title });
  }, [title, titleTransitionKey]);

  useLayoutEffect(() => {
    if (!outgoingTitle || !currentTitleRef.current || !outgoingTitleRef.current)
      return;
    const timing = {
      duration: 170,
      easing: "cubic-bezier(0.18, 0.9, 0.24, 1)",
      fill: "both" as const,
    };
    const incoming = currentTitleRef.current.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      timing,
    );
    const outgoing = outgoingTitleRef.current.animate(
      [{ opacity: 1 }, { opacity: 0 }],
      timing,
    );
    let active = true;
    void Promise.all([incoming.finished, outgoing.finished])
      .then(() => {
        if (active) setOutgoingTitle(null);
      })
      .catch(() => {});
    return () => {
      active = false;
      incoming.cancel();
      outgoing.cancel();
    };
  }, [outgoingTitle]);

  return (
    <WorkspacePanel
      expansion={expansion}
      data-workspace-panel-screen="true"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-panel border border-border/70 bg-card"
    >
      <WorkspacePanelHeader actionsLabel="Chat">
        <div
          data-chat-panel-title
          className="flex min-w-0 flex-1 items-center px-1 font-medium text-sm"
        >
          <div className="relative flex h-5 min-w-0 flex-1 items-center">
            <span
              ref={currentTitleRef}
              data-chat-title-current=""
              className="flex min-w-0 items-center"
            >
              {title}
            </span>
            {outgoingTitle && (
              <span
                ref={outgoingTitleRef}
                data-chat-title-outgoing=""
                aria-hidden="true"
                inert
                className="pointer-events-none absolute inset-0 flex min-w-0 items-center overflow-hidden"
              >
                {outgoingTitle.title}
              </span>
            )}
          </div>
        </div>
      </WorkspacePanelHeader>
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
