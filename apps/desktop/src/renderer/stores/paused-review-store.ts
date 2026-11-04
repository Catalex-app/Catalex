import { createPanelStore } from "@/lib/panel-window-runtime";
import { synchronizePersistedStore } from "@/lib/persisted-store-sync";
import {
  workspaceStatePersistence,
  flushWorkspaceState,
} from "@/lib/workspace-state-storage";
import { persist } from "zustand/middleware";
import { invoke } from "@/lib/desktop/core";
import { useAgentChatStore } from "./agent-chat-store";
import { useDocumentStore } from "./document-store";
import { useAgentReviewQueueStore } from "./agent-review-queue-store";
import {
  reconcileAgentWorkspace,
  type AgentWorkspaceSession,
  type AgentWorkspaceChange,
} from "@/lib/agent-workspace";

interface Inspection {
  changed: boolean;
  revision: string;
  changes: AgentWorkspaceChange[];
}
interface PendingResume {
  session: AgentWorkspaceSession;
  inspection: Inspection;
  prompt: string;
  context?: Parameters<
    ReturnType<typeof useAgentChatStore.getState>["sendPrompt"]
  >[1];
}
async function inspect(session: AgentWorkspaceSession): Promise<Inspection> {
  const doc = useDocumentStore.getState();
  if (doc.projectRoot !== session.projectRoot)
    throw new Error("Open the original project to resume this draft.");
  // Preserve unsaved agent edits in its own sandbox before inspecting it.
  if (doc.agentWorkspaceSessionId === session.sessionId)
    await doc.saveAllFiles({ requireClean: true });
  const current = useDocumentStore.getState();
  if (current.projectRoot !== session.projectRoot)
    throw new Error("The project changed while checking the draft.");
  const sourceFiles = current.agentWorkspaceRoot
    ? (current.sourceViewSnapshot?.files ?? [])
    : current.files;
  return invoke<Inspection>("inspect_paused_workspace", {
    projectRoot: session.projectRoot,
    sessionId: session.sessionId,
    dirtyBuffers: sourceFiles
      .filter((file) => file.isDirty && file.content !== undefined)
      .map((file) => ({
        relativePath: file.relativePath,
        content: file.content,
      })),
  });
}

const create = createPanelStore("paused");
export const usePausedReviewStore = create<{
  pending: Record<string, PendingResume | undefined>;
  backups: Record<string, AgentWorkspaceSession[]>;
  busy: boolean;
  check: (
    tabId: string,
    prompt: string,
    context?: PendingResume["context"],
  ) => Promise<boolean>;
  answer: (tabId: string, answer: string) => Promise<void>;
}>()(
  persist(
    (set, get) => ({
      pending: {},
      backups: {},
      busy: false,
      check: async (tabId, prompt, context) => {
        const tab = useAgentChatStore
          .getState()
          .tabs.find((t) => t.id === tabId);
        const session = tab?.agentWorkspace;
        if (!session || tab.pauseState !== "paused" || session.mode !== "ask")
          return false;
        const inspection = await inspect(session);
        const current = useAgentChatStore.getState();
        if (
          current.activeTabId !== tabId ||
          current.tabs.find((t) => t.id === tabId)?.agentWorkspace
            ?.sessionId !== session.sessionId ||
          useDocumentStore.getState().projectRoot !== session.projectRoot
        )
          throw new Error("The active chat changed while checking the draft.");
        if (!inspection.changed) {
          set((s) => ({ pending: { ...s.pending, [tabId]: undefined } }));
          return false;
        }
        set((s) => ({
          pending: {
            ...s.pending,
            [tabId]: { session, inspection, prompt, context },
          },
        }));
        return true;
      },
      answer: async (tabId, answer) => {
        const item = get().pending[tabId];
        const tab = useAgentChatStore
          .getState()
          .tabs.find((t) => t.id === tabId);
        if (
          !item ||
          get().busy ||
          useAgentChatStore.getState().activeTabId !== tabId ||
          tab?.agentWorkspace?.sessionId !== item.session.sessionId ||
          tab.isStreaming ||
          tab.isSettling
        )
          throw new Error("This resume question is no longer active.");
        if (answer === "Stay paused") {
          set((s) => ({ pending: { ...s.pending, [tabId]: undefined } }));
          return;
        }
        const update = item.inspection.changes.length
          ? "Update the draft"
          : "Continue from the current document";
        if (
          answer !== update &&
          !(
            answer === "Review the saved draft first" &&
            item.inspection.changes.length
          )
        )
          throw new Error("Choose one of the resume options.");
        try {
          set({ busy: true });
          await flushWorkspaceState();
          const fresh = await inspect(item.session);
          if (fresh.revision !== item.inspection.revision) {
            set((s) => ({
              pending: {
                ...s.pending,
                [tabId]: { ...item, inspection: fresh },
              },
            }));
            throw new Error(
              "The document or draft changed again. Please review the refreshed choices.",
            );
          }
          if (
            useAgentChatStore.getState().activeTabId !== tabId ||
            useDocumentStore.getState().projectRoot !== item.session.projectRoot
          )
            throw new Error("Return to this chat before answering.");
          if (answer === "Review the saved draft first") {
            const reconciled = await reconcileAgentWorkspace(
              item.session.projectRoot,
              item.session.sessionId,
              "cancelled",
            );
            useAgentChatStore
              .getState()
              ._setAgentWorkspace(tabId, reconciled.session);
            await useAgentReviewQueueStore
              .getState()
              .enqueue(reconciled.session);
          } else {
            // Keep the old sandbox on disk, including if launching the replacement fails.
            set((s) => ({
              backups: {
                ...s.backups,
                [tabId]: [
                  ...(s.backups[tabId] ?? []).filter(
                    (old) => old.sessionId !== item.session.sessionId,
                  ),
                  item.session,
                ],
              },
            }));
            if (
              useDocumentStore.getState().agentWorkspaceSessionId ===
              item.session.sessionId
            )
              await useDocumentStore.getState().restoreSourceWorkspace();
            await invoke("set_agent_workspace_backup", {
              projectRoot: item.session.projectRoot,
              sessionId: item.session.sessionId,
              backup: true,
            });
            useAgentChatStore.getState()._setAgentWorkspace(tabId, null);
            const prompt = `The user chose to continue from the current document after a pause. Read this NEW sandbox first. Reconsider unfinished edits against the latest text; do not blindly replay them. Preserve user changes. The previous draft remains saved at ${item.session.candidateRoot}.\n\nUser request: ${item.prompt}\n\nPrevious unfinished edits:\n${JSON.stringify(fresh.changes.map((c) => ({ path: c.filePath, before: c.oldContent, proposed: c.newContent, kind: c.kind })))}`;
            try {
              const send = useAgentChatStore.getState().sendPrompt;
              await send(prompt, item.context);
            } catch (error) {
              await invoke("set_agent_workspace_backup", {
                projectRoot: item.session.projectRoot,
                sessionId: item.session.sessionId,
                backup: false,
              });
              useAgentChatStore
                .getState()
                ._setAgentWorkspace(tabId, item.session);
              throw error;
            }
            const started = useAgentChatStore
              .getState()
              .tabs.find((t) => t.id === tabId);
            if (!started?.agentWorkspace) {
              await invoke("set_agent_workspace_backup", {
                projectRoot: item.session.projectRoot,
                sessionId: item.session.sessionId,
                backup: false,
              });
              useAgentChatStore
                .getState()
                ._setAgentWorkspace(tabId, item.session);
              throw new Error(
                started?.error ??
                  "Could not start the updated draft. Your saved draft is unchanged.",
              );
            }
          }
          set((s) => ({ pending: { ...s.pending, [tabId]: undefined } }));
        } finally {
          set({ busy: false });
        }
      },
    }),
    {
      name: "catalex-paused-review",
      ...workspaceStatePersistence,
      partialize: (s) => ({ pending: s.pending, backups: s.backups }),
    },
  ),
);

synchronizePersistedStore(usePausedReviewStore);
