import { usePiSetupStore } from "@/stores/pi-setup-store";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { ChatErrorPanel, type ChatErrorAction } from "./chat-error-panel";
import {
  useAgentChatStore,
  type ChatProvider,
} from "@/stores/agent-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import {
  compileLatex,
  formatCompileError,
  resolveCompileTarget,
} from "@/lib/latex-compiler";
import { useSettingsStore } from "@/stores/settings-store";
import { invoke } from "@/lib/desktop/core";

export function ChatErrorRecovery({
  message,
  source,
  provider,
  agentName,
  effort,
  canFix,
}: {
  message: string;
  source: "chat" | "models" | "setup";
  provider: ChatProvider;
  agentName: string;
  effort: string;
  canFix: boolean;
}) {
  const tabId = useAgentChatStore((s) => s.activeTabId);
  const streaming = useAgentChatStore((s) => s.isStreaming);
  const settling = useAgentChatStore((s) => {
    const tab = s.tabs.find((tab) => tab.id === tabId);
    return !!tab?.isSettling || tab?.turnPhase === "starting";
  });
  const setup =
    provider === "pi"
      ? usePiSetupStore
      : provider === "claude"
        ? useClaudeSetupStore
        : useCodexSetupStore;
  const claudeStatus = useClaudeSetupStore((s) => s.status);
  const codexStatus = useCodexSetupStore((s) => s.status);
  const piStatus = usePiSetupStore((s) => s.status);
  const setupStatus =
    provider === "pi"
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
  const compileFailure = message.startsWith("The agent draft did not compile.");
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
    if (compileFailure) {
      const tab = useAgentChatStore
        .getState()
        .tabs.find((item) => item.id === tabId);
      const workspace = tab?.agentWorkspace;
      if (!workspace)
        throw new Error("The agent draft is no longer available.");
      const doc = useDocumentStore.getState();
      if (doc.agentWorkspaceSessionId === workspace.sessionId)
        await doc.saveAllFiles({ requireClean: true });
      if (!current()) return;
      const target =
        tab.agentVerificationContext ??
        resolveCompileTarget(doc.activeFileId, doc.files);
      if (!target)
        throw new Error("No compilable TeX file was found in this draft.");
      const choice =
        tab.agentVerificationContext ??
        useSettingsStore
          .getState()
          .initializeCompilerChoiceForRoot(
            workspace.projectRoot,
            target.rootId,
          );
      await compileLatex(
        workspace.candidateRoot,
        target.targetPath,
        choice.backend,
        choice.engine,
        choice.autoEngine,
      );
      if (!current()) return;
      useAgentReviewQueueStore.setState((state) => ({
        entries: state.entries.map((entry) =>
          entry.session.sessionId === workspace.sessionId &&
          entry.verificationError === message
            ? { ...entry, verificationError: undefined }
            : entry,
        ),
      }));
      clear();
    } else {
      if (source === "models") await setup.getState().refreshModels();
      else await setup.getState().checkStatus();
      const status = setup.getState();
      if (status.status === "ready" && status.modelsStatus === "ready") clear();
      else if (status.error || status.modelsError)
        throw new Error(status.error ?? status.modelsError ?? message);
    }
  };
  const reconnect = async () => {
    // Reset a failed runtime without replaying a conversation turn. The saved
    // provider session is attached again only on an explicit Continue or Send.
    await invoke(`dispose_${provider}_session`, { tabId });
    if (!current()) return;
    await setup.getState().checkStatus();
    if (!current()) return;
    const status = setup.getState();
    if (status.status !== "ready" || status.modelsStatus !== "ready") {
      throw new Error(
        status.error ??
          status.modelsError ??
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
    const refreshable =
      compileFailure || source !== "chat" || authFailure || setupBlocked;
    actions.push({
      label: refreshable ? "Refresh" : "Reconnect",
      icon: <RefreshCw className="size-3.5" />,
      primary:
        !(canFix && compileFailure && source === "chat") &&
        !authFailure &&
        !setupBlocked,
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
    } else if (canFix && compileFailure && source === "chat") {
      actions.push({
        label: "Fix with chat",
        primary: true,
        icon: <Sparkles className="size-3.5" />,
        onClick: () =>
          void run(async () => {
            if (!current()) return;
            // Use sendPrompt directly: unlike handleSend it does not consume the composer draft.
            await useAgentChatStore
              .getState()
              .sendPrompt(
                "Please investigate and fix the following error. Preserve my manual edits and already-approved changes.\n\n" +
                  message,
                undefined,
                false,
                undefined,
                tabId,
              );
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
