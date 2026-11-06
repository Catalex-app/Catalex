import { LARGE_FILE_THRESHOLD } from "./project-files";
import { browserHarness, hostInvoke } from "./desktop/bridge";
import { compileWorkspace, stopCompilation } from "./workspace-compile";
import { getPublishedCompilation } from "./latex-compiler";
import { useSettingsStore } from "@/stores/settings-store";
import { useHistoryStore } from "@/stores/history-store";
import { useAgentQuestionStore } from "@/stores/agent-question-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { usePausedReviewStore } from "@/stores/paused-review-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { usePiSetupStore } from "@/stores/pi-setup-store";
import {
  useDocumentStore,
  getPdfBytes,
  resolveTexRoot,
} from "@/stores/document-store";
import {
  useAgentChatStore,
  createChatPanelStore,
} from "@/stores/agent-chat-store";
import { toast } from "sonner";
import type {
  PanelWindowKind,
  PanelWindowSession,
} from "./panel-window-runtime";
import { notifyPanelSessionsChanged } from "./panel-window-runtime";
import type { WorkspaceMode } from "./ui-theme";

export function openPanelWindow(
  kind: PanelWindowKind,
  mode: WorkspaceMode,
  target: { fileId?: string; chatId?: string } = {},
) {
  const state = useDocumentStore.getState();
  if (!state.projectRoot) return;
  // A compiled preview belongs to its root document, regardless of which
  // included file opened it. Other panel kinds remain pinned to their file.
  const fileId =
    kind === "preview"
      ? resolveTexRoot(target.fileId ?? state.activeFileId, state.files)
      : (target.fileId ?? state.activeFileId);
  const chatId =
    kind === "chat"
      ? (target.chatId ?? useAgentChatStore.getState().activeTabId)
      : undefined;
  if (kind === "chat") {
    const chat = useAgentChatStore.getState();
    if (
      chat.chatProjectRoot !== state.projectRoot ||
      chat.isLeavingProject ||
      !chat.tabs.some((tab) => tab.id === chatId && !tab.archived)
    )
      return;
  } else if (!state.files.some((file) => file.id === fileId)) return;
  const sessions = (window.__catalexPanelSessions ??= new Map());
  for (const [token, session] of sessions) {
    if (
      session.kind === kind &&
      session.projectRoot === state.projectRoot &&
      (kind === "chat"
        ? session.chatId === chatId
        : session.fileId === fileId) &&
      session.window &&
      !session.window.closed
    ) {
      if (window.catalex) {
        void hostInvoke<boolean>("desktop:window:focusPanel", { token })
          .then((focused) => {
            if (!focused)
              throw new Error("The panel window is no longer available.");
          })
          .catch(() => toast.error("Could not show the panel window."));
      } else {
        session.window.focus();
      }
      return;
    }
  }
  const token = crypto.randomUUID();
  const chatView = chatId ? createChatPanelStore(chatId) : undefined;
  const session: PanelWindowSession = {
    kind,
    mode,
    fileId,
    chatId,
    projectRoot: state.projectRoot,
    document: useDocumentStore,
    stores: {
      chat: chatView?.store ?? useAgentChatStore,
      settings: useSettingsStore,
      history: useHistoryStore,
      questions: useAgentQuestionStore,
      reviews: useAgentReviewQueueStore,
      proposals: useProposedChangesStore,
      paused: usePausedReviewStore,
      claude: useClaudeSetupStore,
      codex: useCodexSetupStore,
      pi: usePiSetupStore,
    },
    pdf: getPdfBytes,
    compilation: getPublishedCompilation,
    compile: compileWorkspace,
    stopCompilation,
    window: null,
    browserHarness: import.meta.env.DEV ? browserHarness() : undefined,
  };
  sessions.set(token, session);
  const url = new URL(window.location.href);
  url.search = new URLSearchParams({ "panel-window": token }).toString();
  url.hash = "";
  const child = window.open(
    url.href,
    `catalex-panel-${token}`,
    "popup,width=960,height=720",
  );
  if (!child) {
    chatView?.dispose();
    sessions.delete(token);
    toast.error("Could not open the panel window.");
    return;
  }
  session.window = child;
  const file = state.files.find((item) => item.id === fileId);
  if (
    kind === "editor" &&
    file &&
    file.content === undefined &&
    file.type !== "image" &&
    file.type !== "pdf" &&
    !file.isBinary &&
    (file.fileSize ?? 0) <= LARGE_FILE_THRESHOLD
  )
    void state.loadFileContent(file.id);
  notifyPanelSessionsChanged();
  const stop = useDocumentStore.subscribe((next) => {
    if (
      next.projectRoot !== session.projectRoot ||
      (kind !== "chat" &&
        !next.files.some((file) => file.id === fileId) &&
        !next.isAgentWorkspaceReadOnly &&
        !next.isApplyingAgentDraft &&
        !(
          next.agentWorkspaceRoot &&
          next.sourceViewSnapshot?.files.some((file) => file.id === fileId)
        ))
    ) {
      if (session.close) void session.close();
      else child.close();
    }
  });
  const stopChat = chatId
    ? useAgentChatStore.subscribe((next) => {
        const chat = next.tabs.find((tab) => tab.id === chatId);
        if (!chat || chat.archived) {
          if (session.close) void session.close();
          else child.close();
        }
      })
    : undefined;
  // The dependent native window also closes automatically with its opener.
  const interval = window.setInterval(() => {
    if (!child.closed) return;
    stop();
    stopChat?.();
    chatView?.dispose();
    sessions.delete(token);
    notifyPanelSessionsChanged();
    clearInterval(interval);
  }, 1000);
}
