import { withCommentPathMutation } from "@/components/workspace/editor/inline-comment-storage";
import type { CommentPathChange } from "@/components/workspace/editor/comment-paths";
import { invoke } from "@/lib/desktop/core";

export type AgentWorkspaceMode = "ask" | "edit";
export type AgentWorkspaceOutcome = "success" | "failed" | "cancelled";

export interface DirtyWorkspaceBuffer {
  relativePath: string;
  content: string;
}

export interface AgentWorkspaceSession {
  version: number;
  sessionId: string;
  projectRoot: string;
  tabId: string;
  sharedSessionId?: string | null;
  mode: AgentWorkspaceMode;
  status: "active" | "review" | "failed" | "cancelled" | "conflict" | "settled";
  createdAt: number;
  updatedAt: number;
  sourceCommit?: string;
  baselineCommit?: string;
  candidateRoot: string;
  warnings: string[];
  dirtyBuffers?: DirtyWorkspaceBuffer[];
}

export interface AgentWorkspaceChange {
  id: string;
  /** Exact proposal version, including binary bytes; absent on older services. */
  proposalRevision?: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  filePath: string;
  oldFilePath: string | null;
  newFilePath: string | null;
  sourceAbsolutePath: string;
  candidateAbsolutePath: string | null;
  oldContent: string | null;
  /** Original baseline retained when the renderer projects oldContent to current. */
  ancestorContent?: string | null;
  newContent: string | null;
  binary: boolean;
  sourceChanged: boolean;
}

export interface AgentWorkspaceReconciliation {
  session: AgentWorkspaceSession;
  changes: AgentWorkspaceChange[];
}

export type AgentMergeSegment =
  | { kind: "resolved"; content: string }
  | { kind: "conflict"; ancestor: string; current: string; agent: string };

export interface AgentWorkspaceDecision {
  changeId: string;
  accept: boolean;
  content?: string;
  resolvedConflict?: boolean;
  deleteFile?: boolean;
  proposalRevision?: string;
  partial?: boolean;
}

export interface AgentWorkspaceConflict {
  changeId: string;
  filePath: string;
  reason: string;
}

export interface AgentWorkspaceApplyResult {
  applied: boolean;
  changedPaths: string[];
  pathChanges?: CommentPathChange[];
  commentWarning?: string | null;
  conflicts: AgentWorkspaceConflict[];
  remainingPreview?: AgentWorkspacePreview;
}

export interface AgentWorkspacePreview extends AgentWorkspaceReconciliation {
  conflicts: AgentWorkspaceConflict[];
  sourceRevision: string;
  projectRevision?: string;
  mergedContents: Record<string, string | null>;
  currentContents: Record<string, string | null>;
  conflictContents?: Record<string, AgentMergeSegment[]>;
}

export function readReviewProjectState(projectRoot: string) {
  return invoke<{ revision: string; gitPending: boolean }>(
    "review_project_state",
    { projectRoot },
  );
}

export function previewAgentWorkspace(
  projectRoot: string,
  sessionId: string,
  decisions?: AgentWorkspaceDecision[],
) {
  return invoke<AgentWorkspacePreview>("preview_agent_workspace", {
    projectRoot,
    sessionId,
    ...(decisions ? { decisions } : {}),
  });
}

export function prepareAgentWorkspace(
  projectRoot: string,
  tabId: string,
  sharedSessionId: string | null,
  mode: AgentWorkspaceMode,
  dirtyBuffers: DirtyWorkspaceBuffer[],
) {
  return invoke<AgentWorkspaceSession>("prepare_agent_workspace", {
    projectRoot,
    tabId,
    sharedSessionId,
    mode,
    dirtyBuffers,
  });
}

export function resumeAgentWorkspace(
  projectRoot: string,
  sessionId: string,
  tabId: string,
  sharedSessionId?: string | null,
) {
  return invoke<AgentWorkspaceSession>("resume_agent_workspace", {
    projectRoot,
    sessionId,
    tabId,
    sharedSessionId,
  });
}

export function reconcileAgentWorkspace(
  projectRoot: string,
  sessionId: string,
  outcome: AgentWorkspaceOutcome,
) {
  return invoke<AgentWorkspaceReconciliation>("reconcile_agent_workspace", {
    projectRoot,
    sessionId,
    outcome,
  });
}

export function applyAgentWorkspace(
  projectRoot: string,
  sessionId: string,
  decisions: AgentWorkspaceDecision[],
  expectedSourceRevision?: string,
  expectedProjectRevision?: string,
) {
  return withCommentPathMutation(projectRoot, () =>
    invoke<AgentWorkspaceApplyResult>("apply_agent_workspace", {
      projectRoot,
      sessionId,
      decisions,
      ...(expectedSourceRevision ? { expectedSourceRevision } : {}),
      ...(expectedProjectRevision ? { expectedProjectRevision } : {}),
    }),
  );
}

export function discardAgentWorkspace(projectRoot: string, sessionId: string) {
  return invoke<void>("discard_agent_workspace", {
    projectRoot,
    sessionId,
  });
}

export function listAgentWorkspaces(projectRoot: string) {
  return invoke<AgentWorkspaceSession[]>("list_agent_workspaces", {
    projectRoot,
  });
}

const workspaceRecoveries = new Map<string, Promise<boolean>>();

/** Recover every pending draft; session identity must never be guessed from recency. */
export function recoverLatestAgentWorkspace(
  projectRoot: string,
): Promise<boolean> {
  const pending = workspaceRecoveries.get(projectRoot);
  if (pending) return pending;
  const recovery = recoverAgentWorkspaces(projectRoot).finally(() => {
    workspaceRecoveries.delete(projectRoot);
  });
  workspaceRecoveries.set(projectRoot, recovery);
  return recovery;
}

async function recoverAgentWorkspaces(projectRoot: string): Promise<boolean> {
  const [
    savedSessions,
    { useAgentChatStore },
    { useDocumentStore },
    { useAgentReviewQueueStore },
    { useProposedChangesStore },
  ] = await Promise.all([
    listAgentWorkspaces(projectRoot),
    import("@/stores/agent-chat-store"),
    import("@/stores/document-store"),
    import("@/stores/agent-review-queue-store"),
    import("@/stores/proposed-changes-store"),
  ]);
  if (useDocumentStore.getState().projectRoot !== projectRoot) return false;
  const { usePausedReviewStore } = await import("@/stores/paused-review-store");
  if (useDocumentStore.getState().projectRoot !== projectRoot) return false;
  const old = (session: AgentWorkspaceSession | null | undefined) =>
    session?.projectRoot === projectRoot && session.version === 1;
  const retiredIds = new Set(savedSessions.filter(old).map((s) => s.sessionId));
  const chat = useAgentChatStore.getState();
  for (const tab of chat.tabs) {
    if (old(tab.agentWorkspace)) {
      retiredIds.add(tab.agentWorkspace!.sessionId);
      chat._retireLegacyWorkspace(tab.id);
    }
  }
  const savedQueue = useAgentReviewQueueStore.getState();
  for (const entry of savedQueue.entries)
    if (old(entry.session)) retiredIds.add(entry.session.sessionId);
  const paused = usePausedReviewStore.getState();
  for (const item of Object.values(paused.pending))
    if (old(item?.session)) retiredIds.add(item!.session.sessionId);
  for (const list of Object.values(paused.backups))
    for (const session of list)
      if (old(session)) retiredIds.add(session.sessionId);
  const review =
    useProposedChangesStore.getState().workspaceReviewsByProject[projectRoot];
  if (old(review?.session)) retiredIds.add(review!.session.sessionId);
  // A queued/paused record may outlive its tab's workspace pointer. Cancel
  // that old round too, while never resetting a tab with a current draft.
  const retiredTabs = new Set(
    savedSessions.filter(old).map((session) => session.tabId),
  );
  for (const entry of savedQueue.entries)
    if (old(entry.session)) retiredTabs.add(entry.session.tabId);
  for (const [tabId, item] of Object.entries(paused.pending))
    if (old(item?.session)) retiredTabs.add(tabId);
  for (const tabId of retiredTabs) chat._retireLegacyWorkspace(tabId);
  if (retiredIds.size) {
    useAgentReviewQueueStore.setState({
      entries: savedQueue.entries.filter((entry) => !old(entry.session)),
    });
    usePausedReviewStore.setState({
      pending: Object.fromEntries(
        Object.entries(paused.pending).filter(
          ([, item]) => !old(item?.session),
        ),
      ),
      backups: Object.fromEntries(
        Object.entries(paused.backups).map(([id, list]) => [
          id,
          list.filter((session) => !old(session)),
        ]),
      ),
    });
    if (old(review?.session))
      useProposedChangesStore.getState().clearWorkspaceReview(projectRoot);
    const doc = useDocumentStore.getState();
    if (
      doc.agentWorkspaceSessionId &&
      retiredIds.has(doc.agentWorkspaceSessionId)
    )
      await doc.restoreSourceWorkspace();
    const { saveProjectChats } = await import("@/lib/project-chat-lifecycle");
    const { flushWorkspaceState } = await import(
      "@/lib/workspace-state-storage"
    );
    await saveProjectChats();
    await flushWorkspaceState();
    const { toast } = await import("sonner");
    toast.info(
      "Old unfinished drafts were discarded. A new request starts from the current project.",
      { id: `retired-drafts:${projectRoot}` },
    );
  }
  const pendingHistory = savedSessions.some((session) =>
    session.warnings.some((warning) =>
      warning.startsWith("History checkpoint pending:"),
    ),
  );
  if (pendingHistory) {
    const { toast } = await import("sonner");
    toast.warning(
      "A history checkpoint could not be saved. Reopen the project to retry.",
      {
        id: `pending-agent-history:${projectRoot}`,
      },
    );
  }
  const sessions = savedSessions.filter(
    (session) => session.version !== 1 && session.status !== "settled",
  );
  const originalTabId = useAgentChatStore.getState().activeTabId;
  const initialTabs = useAgentChatStore.getState().tabs;
  // A tab already owns a live runtime/review. Do not reset its phase or proposal.
  const ids = new Set(sessions.map((session) => session.sessionId));
  const liveRuntimeIds = new Set(
    initialTabs.flatMap((tab) =>
      tab.agentWorkspace &&
      (tab.isStreaming || tab.isSettling || tab.pauseState)
        ? [tab.agentWorkspace.sessionId]
        : [],
    ),
  );
  const interruptedRefinements = new Set(
    useAgentReviewQueueStore
      .getState()
      .entries.filter(
        (entry) =>
          entry.phase === "revising" &&
          !liveRuntimeIds.has(entry.session.sessionId),
      )
      .map((entry) => entry.session.sessionId),
  );
  const liveIds = new Set(
    initialTabs.flatMap((tab) =>
      tab.agentWorkspace &&
      (liveRuntimeIds.has(tab.agentWorkspace.sessionId) ||
        (ids.has(tab.agentWorkspace.sessionId) &&
          tab.agentWorkspace.status !== "active" &&
          !interruptedRefinements.has(tab.agentWorkspace.sessionId)))
        ? [tab.agentWorkspace.sessionId]
        : [],
    ),
  );
  for (const tab of initialTabs) {
    if (tab.agentWorkspace && !liveIds.has(tab.agentWorkspace.sessionId))
      useAgentChatStore.getState()._setAgentWorkspace(tab.id, null);
  }
  useAgentReviewQueueStore.setState((state) => ({
    entries: state.entries.filter(
      (entry) =>
        entry.session.projectRoot !== projectRoot ||
        liveIds.has(entry.session.sessionId) ||
        ids.has(entry.session.sessionId),
    ),
  }));
  let recovered = false;
  for (const session of [...sessions].sort(
    (a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt,
  )) {
    if (useDocumentStore.getState().projectRoot !== projectRoot) break;
    if (liveIds.has(session.sessionId)) continue;
    const savedEntry = useAgentReviewQueueStore
      .getState()
      .entries.find((entry) => entry.session.sessionId === session.sessionId);
    const reconciliation = await reconcileAgentWorkspace(
      projectRoot,
      session.sessionId,
      "failed",
    );
    if (useDocumentStore.getState().projectRoot !== projectRoot) break;
    const chat = useAgentChatStore.getState();
    let owner = chat.tabs.find(
      (tab) =>
        session.sharedSessionId &&
        tab.sharedSessionId === session.sharedSessionId,
    );
    // A newer run in the same conversation must keep its own sandbox.
    if (owner?.isStreaming || owner?.pauseState || owner?.agentWorkspace)
      owner = undefined;
    if (!owner) {
      const tabId = chat.createTab();
      if (session.sharedSessionId) {
        await useAgentChatStore
          .getState()
          .resumeSession(session.sharedSessionId, { useSessionLlm: true });
      }
      owner = useAgentChatStore.getState().tabs.find((tab) => tab.id === tabId);
    }
    if (!owner || useDocumentStore.getState().projectRoot !== projectRoot)
      break;
    const restored = { ...reconciliation.session, tabId: owner.id };
    useAgentChatStore.getState()._setAgentWorkspace(owner.id, restored);
    useAgentReviewQueueStore.setState((state) => ({
      entries: [
        ...state.entries.filter(
          (entry) => entry.session.sessionId !== session.sessionId,
        ),
        savedEntry &&
        ["review", "question", "queued"].includes(savedEntry.phase)
          ? { ...savedEntry, session: restored }
          : {
              ...savedEntry,
              session: restored,
              phase: "queued",
              preview: undefined,
              conflicts: [],
            },
      ],
    }));
    recovered = true;
  }
  if (useDocumentStore.getState().projectRoot !== projectRoot) return recovered;
  if (
    useAgentChatStore.getState().tabs.some((tab) => tab.id === originalTabId)
  ) {
    useAgentChatStore.getState().setActiveTab(originalTabId);
  }
  const queue = useAgentReviewQueueStore.getState();
  if (
    !queue.entries.some((entry) => entry.session.projectRoot === projectRoot)
  ) {
    useProposedChangesStore.getState().clearWorkspaceReview(projectRoot);
  }
  // Transient phases cannot survive process exit. Recheck against disk before applying.
  useAgentReviewQueueStore.setState((state) => ({
    entries: state.entries.map((entry) =>
      entry.session.projectRoot === projectRoot &&
      (["checking", "applying"].includes(entry.phase) ||
        (entry.phase === "revising" &&
          !liveRuntimeIds.has(entry.session.sessionId)))
        ? { ...entry, phase: "queued" }
        : entry,
    ),
  }));
  await queue.advance(projectRoot);
  const head = useAgentReviewQueueStore
    .getState()
    .entries.find((entry) => entry.session.projectRoot === projectRoot);
  if (
    head?.phase === "review" &&
    !initialTabs.some(
      (tab) =>
        tab.isStreaming &&
        tab.agentWorkspace?.sessionId === head.session.sessionId,
    )
  )
    await useAgentReviewQueueStore.getState().show(head.session.sessionId);
  if (recovered) useAgentChatStore.getState().requestDrawerOpen();
  return recovered;
}
