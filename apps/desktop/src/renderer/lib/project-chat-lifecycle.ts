import { freezeRound } from "@/lib/agent-round-timing";
import { flushPanelWindows, isChatPanelOpen } from "./panel-window-runtime";
import {
  flushWorkspaceState,
  readLegacyProjectChats,
  removeLegacyProjectChats,
} from "./workspace-state-storage";
import { invoke } from "@/lib/desktop/core";
import {
  tabFromSharedSession,
  lastCommunicationProvider,
  lastCommunicationDetails,
  type SharedSessionPayload,
  useAgentChatStore,
  type TabState,
} from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";

type ChatState = ReturnType<typeof useAgentChatStore.getState>;
interface ProjectChats {
  version: 1;
  tabs: TabState[];
  activeTabId: string;
  selectedPiModel?: string;
  selectedPiReasoningEffort?: string;
  selectedClaudeModel: ChatState["selectedClaudeModel"];
  selectedCodexModel: ChatState["selectedCodexModel"];
  selectedCodexReasoningEffort: ChatState["selectedCodexReasoningEffort"];
  effortLevel: ChatState["effortLevel"];
}

const storageKey = (root: string) => `catalex-project-chats:${root}`;

const previousMessages = new Map<string, WeakRef<TabState["messages"]>>();
let checkpointQueue: Promise<void> = Promise.resolve();
export function saveProjectChats(): Promise<void> {
  const chat = useAgentChatStore.getState();
  const save = checkpointQueue
    .catch(() => {})
    .then(() =>
      writeProjectChats(
        useAgentChatStore.getState().chatProjectRoot === chat.chatProjectRoot
          ? useAgentChatStore.getState()
          : chat,
      ),
    );
  checkpointQueue = save.catch(() => {});
  return save;
}
export function withChatCheckpoint<T>(operation: () => Promise<T>): Promise<T> {
  const work = checkpointQueue
    .catch(() => {})
    .then(async () => {
      await writeProjectChats(useAgentChatStore.getState());
      return operation();
    });
  checkpointQueue = work.then(
    () => {},
    () => {},
  );
  return work;
}
export async function waitForChatCheckpointWrites() {
  await checkpointQueue.catch(() => {});
}
async function writeProjectChats(chat: ChatState) {
  if (!chat.chatProjectRoot) return;
  const snapshot: ProjectChats = {
    version: 1,
    tabs: chat.tabs,
    activeTabId: chat.activeTabId,
    selectedPiModel: chat.selectedPiModel,
    selectedPiReasoningEffort: chat.selectedPiReasoningEffort,
    selectedClaudeModel: chat.selectedClaudeModel,
    selectedCodexModel: chat.selectedCodexModel,
    selectedCodexReasoningEffort: chat.selectedCodexReasoningEffort,
    effortLevel: chat.effortLevel,
  };
  await invoke("desktop:chat:checkpoint-save", {
    projectRoot: chat.chatProjectRoot,
    snapshot: {
      ...snapshot,
      tabs: snapshot.tabs.map((savedTab) => {
        const tab = {
          ...savedTab,
          lastCommunicationProvider: lastCommunicationProvider(savedTab),
          lastCommunication: lastCommunicationDetails(savedTab),
          providerStatus: undefined,
          roundTiming: savedTab.roundTiming
            ? freezeRound(savedTab.roundTiming)
            : savedTab.roundTiming,
        };
        if (tab.history?.writable)
          return {
            ...tab,
            history: undefined,
            checkpointPatch: {
              start: tab.history.start,
              total: tab.history.start + tab.messages.length,
            },
          };
        if (tab.history) return { ...tab, messages: [] };
        const previous = previousMessages
          .get(`${chat.chatProjectRoot}:${tab.id}`)
          ?.deref();
        if (!previous) return tab;
        let prefix = 0;
        while (
          prefix < previous.length &&
          prefix < tab.messages.length &&
          previous[prefix] === tab.messages[prefix]
        )
          prefix++;
        const start = Math.floor(prefix / 100) * 100;
        return {
          ...tab,
          messages: tab.messages.slice(start),
          checkpointPatch: { start, total: tab.messages.length },
        };
      }),
    },
  });
  for (const tab of snapshot.tabs) {
    for (const message of tab.pendingReviewDecisions ?? []) {
      const total = await invoke<number>("desktop:chat:append-review", {
        projectRoot: chat.chatProjectRoot,
        tabId: tab.id,
        runtimeSessionKey: tab.runtimeSessionKey,
        message,
      });
      useAgentChatStore.setState((current) => {
        if (current.chatProjectRoot !== chat.chatProjectRoot) return current;
        const existing = current.tabs.find((item) => item.id === tab.id);
        if (!existing || existing.runtimeSessionKey !== tab.runtimeSessionKey)
          return current;
        const messages =
          existing.messages.some((item) => item.uuid === message.uuid) ||
          (existing.history &&
            existing.history.start + existing.messages.length !== total - 1)
            ? existing.messages
            : [...existing.messages, message];
        const updated = {
          ...existing,
          messages,
          history: existing.history
            ? { ...existing.history, total }
            : undefined,
          pendingReviewDecisions: existing.pendingReviewDecisions?.filter(
            (item) => item.uuid !== message.uuid,
          ),
        };
        return {
          tabs: current.tabs.map((item) =>
            item.id === tab.id ? updated : item,
          ),
          ...(current.activeTabId === tab.id ? { messages } : {}),
        };
      });
    }
    if (!tab.history)
      previousMessages.set(
        `${chat.chatProjectRoot}:${tab.id}`,
        new WeakRef(tab.messages),
      );
  }
  // Drop only the exact idle transcript acknowledged by this save. A later
  // streamed update or draft edit must never be replaced by an older snapshot.
  useAgentChatStore.setState((current) => {
    if (current.chatProjectRoot !== chat.chatProjectRoot) return current;
    let changed = false;
    const tabs = current.tabs.map((tab) => {
      if (
        tab.id === current.activeTabId ||
        isChatPanelOpen(tab.id) ||
        tab.isStreaming ||
        tab.isSettling ||
        tab.turnPhase ||
        tab.agentWorkspace ||
        tab.pendingQuestion ||
        !snapshot.tabs.includes(tab) ||
        tab.messages.length === 0
      )
        return tab;
      changed = true;
      const total = tab.history?.writable
        ? tab.history.start + tab.messages.length
        : (tab.history?.total ?? tab.messages.length);
      return {
        ...tab,
        lastCommunicationProvider: lastCommunicationProvider(tab),
        lastCommunication: lastCommunicationDetails(tab),
        messages: [],
        history: { total, start: total },
      };
    });
    return changed ? { tabs } : current;
  });
}

export async function restoreProjectChats(projectRoot: string) {
  await checkpointQueue.catch(() => {});
  for (const key of previousMessages.keys())
    if (key.startsWith(`${projectRoot}:`)) previousMessages.delete(key);
  const raw = await readLegacyProjectChats(storageKey(projectRoot));
  const checkpoint = await invoke<ProjectChats | null>(
    "desktop:chat:checkpoint-load",
    { projectRoot },
  );
  let saved = checkpoint ?? (raw ? (JSON.parse(raw) as ProjectChats) : null);
  if (saved && (saved.version !== 1 || !Array.isArray(saved.tabs)))
    throw new Error("The saved chats could not be restored.");
  if (!checkpoint && saved) {
    // Keep the browser copy until the native checkpoint is durably published.
    await invoke("desktop:chat:checkpoint-save", {
      projectRoot,
      snapshot: saved,
    });
    saved = await invoke<ProjectChats>("desktop:chat:checkpoint-load", {
      projectRoot,
    });
  }
  if (raw && saved) await removeLegacyProjectChats(storageKey(projectRoot));
  const sessions = await invoke<
    { shared_session_id: string; archived: boolean }[]
  >("list_shared_sessions", { projectPath: projectRoot });
  const archived = new Set(
    sessions
      .filter((session) => session.archived)
      .map((session) => session.shared_session_id),
  );
  let tabs: TabState[] = (saved?.tabs ?? []).map((tab) => ({
    ...tab,
    archived: tab.sharedSessionId ? archived.has(tab.sharedSessionId) : false,
  }));
  const existing = new Set(tabs.map((tab) => tab.sharedSessionId));
  // Import old shared-session files one at a time. Later opens use metadata
  // and chunked history, without materializing every legacy transcript together.
  for (const session of sessions) {
    if (session.archived || existing.has(session.shared_session_id)) continue;
    const tab = tabFromSharedSession(
      await invoke<SharedSessionPayload>("load_shared_session", {
        projectPath: projectRoot,
        sharedSessionId: session.shared_session_id,
      }),
    );
    const state = useAgentChatStore.getState();
    await invoke("desktop:chat:checkpoint-save", {
      projectRoot,
      snapshot: {
        version: 1,
        selectedPiModel: saved?.selectedPiModel ?? state.selectedPiModel,
        selectedPiReasoningEffort:
          saved?.selectedPiReasoningEffort ?? state.selectedPiReasoningEffort,
        selectedClaudeModel:
          saved?.selectedClaudeModel ?? state.selectedClaudeModel,
        selectedCodexModel:
          saved?.selectedCodexModel ?? state.selectedCodexModel,
        selectedCodexReasoningEffort:
          saved?.selectedCodexReasoningEffort ??
          state.selectedCodexReasoningEffort,
        effortLevel: saved?.effortLevel ?? state.effortLevel,
        activeTabId: saved?.activeTabId ?? tab.id,
        tabs: [...tabs, tab],
      },
    });
    const imported = await invoke<ProjectChats>(
      "desktop:chat:checkpoint-load",
      { projectRoot },
    );
    tabs = imported.tabs;
  }
  useAgentChatStore
    .getState()
    .restoreProjectTabs(projectRoot, tabs, saved?.activeTabId);
  const active = useAgentChatStore
    .getState()
    .tabs.find((tab) => tab.id === useAgentChatStore.getState().activeTabId);
  if (active?.history)
    await useAgentChatStore
      .getState()
      .loadHistory(active.id, Math.max(0, active.history.total - 200), 200);
  if (saved)
    useAgentChatStore.setState({
      selectedPiModel:
        saved.selectedPiModel ?? useAgentChatStore.getState().selectedPiModel,
      selectedPiReasoningEffort:
        saved.selectedPiReasoningEffort ??
        useAgentChatStore.getState().selectedPiReasoningEffort,
      selectedClaudeModel: saved.selectedClaudeModel,
      selectedCodexModel: saved.selectedCodexModel,
      selectedCodexReasoningEffort: saved.selectedCodexReasoningEffort,
      effortLevel: saved.effortLevel,
    });
}

/** Checkpoint running turns too, so an unexpected app exit restores them paused. */
export function subscribeProjectChats(onError: (error: unknown) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  let dirty = false;
  const flush = async () => {
    if (saving) {
      dirty = true;
      return;
    }
    saving = true;
    clearTimeout(timer);
    timer = undefined;
    try {
      useAgentReviewQueueStore.getState().captureEdits();
      await saveProjectChats();
    } catch (error) {
      onError(error);
    } finally {
      saving = false;
      if (dirty) {
        dirty = false;
        void flush();
      }
    }
  };
  const unsubscribe = useAgentChatStore.subscribe(() => {
    if (!timer) timer = setTimeout(flush, 150);
  });
  const unsubscribeDocuments = useDocumentStore.subscribe((state, previous) => {
    if (state.agentWorkspaceSessionId && state.files !== previous.files)
      flush();
  });
  window.addEventListener("beforeunload", flush);
  return () => {
    flush();
    unsubscribe();
    unsubscribeDocuments();
    window.removeEventListener("beforeunload", flush);
  };
}

let leaving: Promise<void> | null = null;

export class CommentSaveExitError extends Error {}
export class ProjectExitCanceled extends Error {}

export function prepareProjectExit(
  options: {
    skipCommentWrites?: boolean;
    waitForComments?: (saving: Promise<void>) => Promise<void>;
  } = {},
): Promise<void> {
  if (leaving) return leaving;
  leaving = pauseAndSave(options).finally(() => {
    leaving = null;
  });
  return leaving;
}

async function pauseAndSave(options: {
  skipCommentWrites?: boolean;
  waitForComments?: (saving: Promise<void>) => Promise<void>;
}) {
  const chat = useAgentChatStore.getState();
  useAgentChatStore.setState({ isLeavingProject: true });
  try {
    await Promise.all(chat.tabs.map((tab) => chat.pauseExecution(tab.id)));
    const deadline = Date.now() + 20_000;
    while (true) {
      const current = useAgentChatStore.getState();
      const failed = current.tabs.find(
        (tab) => tab.isStreaming && !tab.pauseState && tab.error,
      );
      if (failed) throw new Error(failed.error!);
      const projectRoot = useDocumentStore.getState().projectRoot;
      const busy =
        current.tabs.some(
          (tab) =>
            tab.isStreaming || tab.isSettling || tab.turnPhase === "starting",
        ) ||
        useAgentReviewQueueStore
          .getState()
          .entries.some(
            (entry) =>
              entry.session.projectRoot === projectRoot &&
              ["checking", "applying"].includes(entry.phase),
          ) ||
        useProposedChangesStore.getState().workspaceReview?.isApplying;
      if (!busy) break;
      if (Date.now() >= deadline)
        throw new Error(
          "The chats are still pausing or saving. Please try again in a moment.",
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    useAgentReviewQueueStore.getState().captureEdits();
    const doc = useDocumentStore.getState();
    // Review buffers are persisted separately; writing them to source would accept the draft.
    if (!doc.agentWorkspaceRoot)
      await doc.saveAllFiles({ requireClean: true, deferCommentSync: true });
    await Promise.all(
      useAgentChatStore
        .getState()
        .tabs.filter((tab) => !tab.history || tab.history.writable)
        .map((tab) => chat._syncSharedSession(tab.id)),
    );
    await saveProjectChats();
    await flushWorkspaceState();
    // Comment-only changes must land before the project lease or window closes.
    // Manuscript/chat writes above remain independent if comment storage fails.
    if (doc.projectRoot && !options.skipCommentWrites) {
      const { flushProjectCommentWrites, synchronizeProjectCommentAnchors } =
        await import("@/components/workspace/editor/inline-comment-storage");
      try {
        const root = doc.projectRoot;
        const saving = (async () => {
          await flushPanelWindows();
          await flushProjectCommentWrites(root);
          if (!doc.agentWorkspaceRoot)
            await synchronizeProjectCommentAnchors(root);
          await flushProjectCommentWrites(root);
        })();
        await (options.waitForComments
          ? options.waitForComments(saving)
          : saving);
      } catch (error) {
        if (error instanceof ProjectExitCanceled) throw error;
        throw new CommentSaveExitError(
          `Comment changes could not be saved. The project remains open; retry closing after resolving the storage error. ${String(error)}`,
        );
      }
    }
  } catch (error) {
    useAgentChatStore.setState({ isLeavingProject: false });
    throw error;
  }
}

/** Keep the tab strip in sync with archive changes made from session history. */
export async function updateArchivedChatTab(
  projectRoot: string,
  sharedSessionId: string,
  archived: boolean,
) {
  const chat = useAgentChatStore.getState();
  const existing = chat.tabs.find(
    (tab) => tab.sharedSessionId === sharedSessionId,
  );
  const restored =
    !archived && !existing
      ? tabFromSharedSession(
          await invoke<SharedSessionPayload>("load_shared_session", {
            projectPath: projectRoot,
            sharedSessionId,
          }),
        )
      : undefined;
  if (useDocumentStore.getState().projectRoot !== projectRoot) return;
  useAgentChatStore
    .getState()
    .updateSessionArchive(sharedSessionId, archived, restored);
}
