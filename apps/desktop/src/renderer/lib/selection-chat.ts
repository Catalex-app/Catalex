import { useAgentChatStore, type TabState } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { isSameSelectionContext, type ChatContextBadge } from "./chat-context";
import { openChatPanelSnapshot } from "./panel-window-runtime";

export function selectionChatTargets(
  tabs: TabState[],
  activeTabId: string,
  openPanels: string,
) {
  const open = new Set(openPanels.split("\n"));
  return tabs
    .filter(
      (tab) => !tab.archived && (tab.id === activeTabId || open.has(tab.id)),
    )
    .map((tab) => ({
      tab,
      location:
        tab.id === activeTabId
          ? open.has(tab.id)
            ? "Main & Pop-out"
            : "Main"
          : "Pop-out",
    }))
    .sort(
      (a, b) =>
        Number(b.tab.id === activeTabId) - Number(a.tab.id === activeTabId),
    );
}

/** Attach to an explicit chat without changing the active tab or submitting a prompt. */
export function pinSelectionToChat(
  tabId: string,
  context: ChatContextBadge,
  projectRoot: string,
): boolean {
  return (
    Boolean(context.selectedText) &&
    pinContextToChat(tabId, context, projectRoot)
  );
}

/** Whole-file references also support PDFs, binary files, and empty documents. */
export function pinFileToChat(
  tabId: string,
  filePath: string,
  content: string,
  projectRoot: string,
): boolean {
  return pinContextToChat(
    tabId,
    {
      label: `@${filePath}`,
      filePath,
      selectedText: content,
      selectionKey: `file:${filePath}`,
    },
    projectRoot,
  );
}

function pinContextToChat(
  tabId: string,
  context: ChatContextBadge,
  projectRoot: string,
): boolean {
  const state = useAgentChatStore.getState();
  if (
    useDocumentStore.getState().projectRoot !== projectRoot ||
    state.chatProjectRoot !== projectRoot
  )
    return false;
  const target = selectionChatTargets(
    state.tabs,
    state.activeTabId,
    openChatPanelSnapshot(),
  ).find(({ tab }) => tab.id === tabId)?.tab;
  if (!target) return false;
  state.saveDraft(tabId, {
    ...target.draft,
    pinnedContexts: [
      ...target.draft.pinnedContexts.filter(
        (item) => !isSameSelectionContext(item, context),
      ),
      { ...context, selectionPinned: true },
    ],
  });
  return true;
}
