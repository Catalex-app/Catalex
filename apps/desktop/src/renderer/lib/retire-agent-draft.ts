import {
  discardAgentWorkspace,
  type AgentWorkspaceSession,
} from "./agent-workspace";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import {
  getProposedChangesProjectKey,
  useProposedChangesStore,
} from "@/stores/proposed-changes-store";

// Queue advancement belongs to the caller, after retirement (and any archive
// persistence). Never use this for a draft that still needs review/refinement.
export async function retireAgentDraft(
  session: AgentWorkspaceSession,
  { settled = false }: { settled?: boolean } = {},
): Promise<unknown> {
  const { projectRoot, sessionId, tabId } = session;
  const doc = useDocumentStore.getState();
  if (
    doc.projectRoot === projectRoot &&
    doc.agentWorkspaceSessionId === sessionId
  )
    await doc.restoreSourceWorkspace();

  let cleanupError: unknown;
  try {
    await discardAgentWorkspace(projectRoot, sessionId);
  } catch (error) {
    // Accepted/rejected drafts are already settled durably. Native cleanup can
    // retry their retained artifacts on restart; unfinished drafts keep all refs.
    if (!settled) throw error;
    cleanupError = error;
  }

  const chat = useAgentChatStore.getState();
  if (
    chat.tabs.find((tab) => tab.id === tabId)?.agentWorkspace?.sessionId ===
    sessionId
  )
    chat._setAgentWorkspace(tabId, null);

  const key = getProposedChangesProjectKey(projectRoot);
  if (key)
    useProposedChangesStore.setState((state) => {
      const changes = (state.changesByProject[key] ?? []).filter(
        (change) => change.workspaceSessionId !== sessionId,
      );
      const changesByProject = { ...state.changesByProject };
      if (changes.length) changesByProject[key] = changes;
      else delete changesByProject[key];
      const workspaceReviewsByProject = { ...state.workspaceReviewsByProject };
      if (workspaceReviewsByProject[key]?.session.sessionId === sessionId)
        delete workspaceReviewsByProject[key];
      return {
        changesByProject,
        workspaceReviewsByProject,
        ...(state.activeProjectRoot === key
          ? {
              changes: state.changes.filter(
                (change) => change.workspaceSessionId !== sessionId,
              ),
              workspaceReview:
                state.workspaceReview?.session.sessionId === sessionId
                  ? null
                  : state.workspaceReview,
            }
          : {}),
      };
    });
  return cleanupError;
}
