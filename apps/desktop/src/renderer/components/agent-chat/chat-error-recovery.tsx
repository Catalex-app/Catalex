import { useAntigravitySetupStore } from "@/stores/antigravity-setup-store";
import { usePiSetupStore } from "@/stores/pi-setup-store";
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ChatErrorPanel, type ChatErrorAction } from "./chat-error-panel";
import {
  useAgentChatStore,
  type ChatProvider,
} from "@/stores/agent-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { formatCompileError } from "@/lib/latex-compiler";
import { invoke } from "@/lib/desktop/core";

export function ChatErrorRecovery({
  message,
  source,
  provider,
  agentName,
  effort,
}: {
  message: string;
  source: "chat" | "models" | "setup";
  provider: ChatProvider;
  agentName: string;
  effort: string;
}) {
  const tabId = useAgentChatStore((s) => s.activeTabId);
  const streaming = useAgentChatStore((s) => s.isStreaming);
  const settling = useAgentChatStore((s) => {
    const tab = s.tabs.find((tab) => tab.id === tabId);
    return !!tab?.isSettling || tab?.turnPhase === "starting";
  });
  const setup =
    provider === "antigravity"
      ? useAntigravitySetupStore
      : provider === "pi"
        ? usePiSetupStore
        : provider === "claude"
          ? useClaudeSetupStore
          : useCodexSetupStore;
  const claudeStatus = useClaudeSetupStore((s) => s.status);
  const codexStatus = useCodexSetupStore((s) => s.status);
  const piStatus = usePiSetupStore((s) => s.status);
  const antigravityStatus = useAntigravitySetupStore((s) => s.status);
  const setupStatus =
    provider === "antigravity"
      ? antigravityStatus
      : provider === "pi"
        ? piStatus
        : provider === "claude"
          ? claudeStatus
          : codexStatus;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const current = () => {
    const state = useAgentChatStore.getState();
    return (
      state.activeTabId === tabId &&
      state.selectedProvider === provider &&
      (source !== "chat" ||
        state.tabs.find((tab) => tab.id === tabId)?.error === message)
    );
  };
  const clear = () => {
    if (source === "chat" && current())
      useAgentChatStore.getState()._recoverError(tabId, message);
  };
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current || !current()) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      if (current()) setActionError(formatCompileError(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const revokedClaudeToken =
    provider === "claude" &&
    /\b401\s+OAuth access token has been revoked\b/i.test(message);
  const authFailure = setupStatus === "not-authenticated" || revokedClaudeToken;
  const setupBlocked = setupStatus !== "ready" && setupStatus !== "checking";
  const previousStatus = useRef(setupStatus);
  useEffect(() => {
    if (
      !revokedClaudeToken &&
      !inFlight.current &&
      previousStatus.current === "not-authenticated" &&
      setupStatus === "ready"
    )
      clear();
    previousStatus.current = setupStatus;
  }, [setupStatus, authFailure, revokedClaudeToken]);
  const reloadClaude = async () => {
    const state = useAgentChatStore.getState();
    if (state.isStreaming) return;
    const modelId = state.selectedClaudeModel;
    await invoke("dispose_claude_session", { tabId });
    if (!current()) return;
    // auth status and model discovery can succeed with a revoked saved token.
    // A fresh, tool-free request must succeed before dismissing this error.
    await invoke("verify_claude_model", { modelId });
    if (!current()) return;
    await useClaudeSetupStore.getState().checkStatus();
    const status = useClaudeSetupStore.getState();
    if (status.status !== "ready" || status.modelsStatus !== "ready") {
      throw new Error(
        status.error ??
          status.modelsError ??
          "Claude is not ready. Complete sign-in in your terminal and try again.",
      );
    }
    clear();
  };
  const refresh = async () => {
    if (source === "models") await setup.getState().refreshModels();
    else await setup.getState().checkStatus();
    const status = setup.getState();
    const modelsError = "modelsError" in status ? status.modelsError : null;
    if (status.status === "ready" && !(status.error || modelsError)) clear();
    else if (status.error || modelsError)
      throw new Error(status.error ?? modelsError ?? message);
  };
  const reconnect = async () => {
    // Reset a failed runtime without replaying a conversation turn. The saved
    // provider session is attached again only on an explicit Continue or Send.
    await invoke(`dispose_${provider}_session`, { tabId });
    if (!current()) return;
    await setup.getState().checkStatus();
    if (!current()) return;
    const status = setup.getState();
    if (
      status.status !== "ready" ||
      ("modelsStatus" in status && status.modelsStatus !== "ready")
    ) {
      throw new Error(
        status.error ??
          ("modelsError" in status ? status.modelsError : null) ??
          "The agent is not ready. Check Agent Settings and reconnect again.",
      );
    }
    clear();
  };
  const actions: ChatErrorAction[] = [];
  if (streaming) {
    actions.push({
      label: "Stop",
      primary: true,
      onClick: () =>
        void run(async () => {
          await useAgentChatStore.getState().pauseExecution();
        }),
    });
  } else if (revokedClaudeToken) {
    actions.push({
      label: "Reload Claude",
      icon: <RefreshCw className="size-3.5" />,
      primary: true,
      onClick: () => void run(reloadClaude),
    });
  } else {
    // Provider recovery and sending a new chat turn are separate actions.
    const refreshable = source !== "chat" || authFailure || setupBlocked;
    actions.push({
      label: refreshable ? "Refresh" : "Reconnect",
      icon: <RefreshCw className="size-3.5" />,
      primary: !authFailure && !setupBlocked,
      onClick: () => void run(refreshable ? refresh : reconnect),
    });
    if (authFailure || setupBlocked) {
      actions.push({
        label: "Settings",
        primary: true,
        onClick: () =>
          void run(async () => {
            await invoke("open_settings_window", {
              section: "agent",
              provider,
            });
          }),
      });
    }
  }
  return (
    <ChatErrorPanel
      message={
        revokedClaudeToken && actionError
          ? `${message}\n\nReload failed: ${actionError}`
          : (actionError ?? message)
      }
      guidance={
        revokedClaudeToken ? (
          <div className="mt-2 space-y-2 whitespace-normal">
            <p>Run in your terminal:</p>
            <pre className="select-text whitespace-pre-wrap rounded bg-black/10 px-2 py-1 font-mono text-xs">
              {"claude auth logout\nclaude auth login"}
            </pre>
            <p>After signing in, click Reload Claude.</p>
          </div>
        ) : undefined
      }
      agentName={agentName}
      effort={effort}
      actions={actions.map((action) => ({
        ...action,
        disabled: busy || settling,
        busy:
          busy &&
          (action.label === "Refresh" ||
            action.label === "Reload Claude" ||
            action.label === "Reconnect"),
      }))}
    />
  );
}
