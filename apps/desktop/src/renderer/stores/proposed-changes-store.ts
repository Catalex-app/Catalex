import { PRODUCT_NAME } from "../../branding";
import {
  normalizeDocumentText,
  normalizeReviewText,
  encodeDocumentText,
} from "@/lib/document-text";
import { retireAgentDraft } from "@/lib/retire-agent-draft";
import { writeTexFileContent } from "@/lib/project-files";
import { synchronizeProjectCommentAnchors } from "@/components/workspace/editor/inline-comment-storage";
import {
  workspaceStatePersistence,
  flushWorkspaceState,
} from "@/lib/workspace-state-storage";
import { create } from "zustand";
import { toast } from "sonner";
import { persist } from "zustand/middleware";
import { synchronizePersistedStore } from "@/lib/persisted-store-sync";
import { useDocumentStore } from "./document-store";
import { createLogger } from "@/lib/debug/logger";
import { useHistoryStore } from "./history-store";
import {
  type AgentWorkspaceChange,
  type AgentWorkspaceDecision,
  type AgentMergeSegment,
  type AgentWorkspaceSession,
  applyAgentWorkspace,
  previewAgentWorkspace,
} from "@/lib/agent-workspace";

const log = createLogger("proposed-changes");

export interface ProposedChange {
  id: string; // tool_use_id
  filePath: string; // relativePath
  absolutePath: string;
  oldContent: string; // content before the LLM edit
  newContent: string; // content after the LLM edit (from disk)
  toolName: string; // "Edit" | "Write" | "MultiEdit"
  timestamp: number;
  workspaceSessionId?: string;
  workspaceChangeKind?: AgentWorkspaceChange["kind"];
  oldFilePath?: string | null;
  newFilePath?: string | null;
  binary?: boolean;
  sourceAbsolutePath?: string;
  sourceChanged?: boolean;
  proposalRevision?: string;
  conflictContents?: AgentMergeSegment[];
  resolvedConflict?: boolean;
  deleteFile?: boolean;
  conflictMissingVersions?: Array<"ancestor" | "current" | "agent">;
  /** Source-side text after inline decisions; pending proposal text stays separate. */
  reviewedContent?: string;
}

interface WorkspaceReview {
  session: AgentWorkspaceSession;
  originalChanges: ProposedChange[];
  decisions: Record<string, Omit<AgentWorkspaceDecision, "changeId">>;
  settlementError: string | null;
  sourceRevision?: string;
  isApplying?: boolean;
}

interface ProposedChangesState {
  changes: ProposedChange[];
  activeProjectRoot: string | null;
  changesByProject: Record<string, ProposedChange[]>;
  workspaceReviewsByProject: Record<string, WorkspaceReview>;
  workspaceReview: WorkspaceReview | null;

  // Actions
  activateProject: (projectRoot: string | null) => void;
  startWorkspaceReview: (
    session: AgentWorkspaceSession,
    changes: AgentWorkspaceChange[],
    sourceRevision?: string,
    conflictContents?: Record<string, AgentMergeSegment[]>,
  ) => void;
  resolveConflict: (id: string, content: string, deleteFile?: boolean) => void;
  setReviewedContent: (id: string, content: string) => void;
  clearWorkspaceReview: (projectRoot: string) => void;
  addChange: (change: Omit<ProposedChange, "timestamp">) => void;
  resolveChange: (id: string) => void;
  resolveChangesForFiles: (filePaths: string[]) => void;
  keepChange: (id: string) => Promise<void>;
  undoChange: (id: string) => Promise<void>;
  settleIfReviewed: () => Promise<void>;
  keepAll: () => Promise<void>;
  undoAll: () => Promise<void>;
  getChangeForFile: (relativePath: string) => ProposedChange | undefined;
}

export const PROPOSED_CHANGES_STORAGE_KEY = "catalex-proposed-changes";

export function getProposedChangesProjectKey(
  projectRoot: string | null,
): string | null {
  if (!projectRoot) return null;
  const normalized = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function updateActiveProjectChanges(
  state: ProposedChangesState,
  changes: ProposedChange[],
) {
  const projectRoot = state.activeProjectRoot;
  if (!projectRoot) return { changes };

  const changesByProject = { ...state.changesByProject };
  if (changes.length > 0) {
    changesByProject[projectRoot] = changes;
  } else {
    delete changesByProject[projectRoot];
  }
  return { changes, changesByProject };
}

function updateConflictChange(
  state: ProposedChangesState,
  id: string,
  update: (change: ProposedChange) => ProposedChange,
): Partial<ProposedChangesState> {
  const review = state.workspaceReview;
  const change = state.changes.find((item) => item.id === id);
  const projectKey = getProposedChangesProjectKey(
    review?.session.projectRoot ?? null,
  );
  if (!review || review.isApplying || !change?.conflictContents || !projectKey)
    return {};
  const nextChange = update(change);
  const replace = (item: ProposedChange) =>
    item.id === id ? nextChange : item;
  const next = {
    ...review,
    originalChanges: review.originalChanges.map(replace),
  };
  return {
    ...updateActiveProjectChanges(state, state.changes.map(replace)),
    workspaceReview: next,
    workspaceReviewsByProject: {
      ...state.workspaceReviewsByProject,
      [projectKey]: next,
    },
  };
}

// All app-owned source writes use the document save queue and its native
// expected-content check/comment revision preparation. Raw filesystem writes
// make our own review decisions look like unknown external replacements.
async function saveReviewedSource(
  change: ProposedChange,
  content: string,
  settle: () => void,
) {
  const start = useDocumentStore.getState();
  let file = start.files.find(
    (file) =>
      file.relativePath === change.filePath &&
      file.absolutePath === change.absolutePath,
  );
  if (!start.projectRoot || !file || start.agentWorkspaceRoot)
    throw new Error("Reopen the source file before saving this review.");
  if (file.content == null) {
    await start.reloadFile(change.filePath);
    const current = useDocumentStore.getState();
    file = current.files.find(
      (file) =>
        file.relativePath === change.filePath &&
        file.absolutePath === change.absolutePath,
    );
    if (
      current.projectRoot !== start.projectRoot ||
      current.agentWorkspaceRoot ||
      !file ||
      file.content == null
    )
      throw new Error("The workspace changed while loading the reviewed file.");
  }
  const current = useDocumentStore.getState();
  if (
    current.isGitOperationRunning ||
    current.isApplyingAgentDraft ||
    current.isAgentWorkspaceReadOnly ||
    file.externalChange
  )
    throw new Error(
      "Resolve the current file operation before saving this review.",
    );
  // Retain review records if validation/loading failed. Once the decision is
  // applied to the source buffer, ordinary save retry owns persistence failures.
  settle();
  if (file.content !== content) current.updateFileContent(file.id, content);
  await current.saveFile(file.id);
}

async function settleWorkspaceDecision(
  id: string,
  accept: boolean,
  content: string | undefined,
  get: () => ProposedChangesState,
  set: (
    updater: (state: ProposedChangesState) => Partial<ProposedChangesState>,
  ) => void,
  apply = true,
) {
  let workspaceSessionId: string | null = null;
  set((state) => {
    const change = state.changes.find((item) => item.id === id);
    const review = state.workspaceReview;
    if (!change?.workspaceSessionId || !review || review.isApplying) return {};
    workspaceSessionId = change.workspaceSessionId;
    const nextReview: WorkspaceReview = {
      ...review,
      decisions: {
        ...review.decisions,
        [id]: {
          accept,
          ...(content === undefined ? {} : { content }),
          ...(change.proposalRevision
            ? { proposalRevision: change.proposalRevision }
            : {}),
          ...(change.resolvedConflict
            ? {
                resolvedConflict: true,
                proposalRevision: change.proposalRevision,
                ...(change.deleteFile && !content ? { deleteFile: true } : {}),
              }
            : {}),
        },
      },
      settlementError: null,
    };
    const nextChanges = state.changes.filter((item) => item.id !== id);
    const changesUpdate = updateActiveProjectChanges(state, nextChanges);
    const projectKey = state.activeProjectRoot;
    return {
      ...changesUpdate,
      workspaceReview: nextReview,
      workspaceReviewsByProject: projectKey
        ? { ...state.workspaceReviewsByProject, [projectKey]: nextReview }
        : state.workspaceReviewsByProject,
    };
  });

  if (!workspaceSessionId) return;
  const state = get();
  const review = state.workspaceReview;
  if (!review || review.session.sessionId !== workspaceSessionId) return;
  if (apply) await settleWorkspaceReview(review, set);
}

/** Shares the manual acceptance transaction without publishing review controls. */
export async function applyWorkspaceAutomatically(
  session: AgentWorkspaceSession,
  changes: AgentWorkspaceChange[],
  sourceRevision: string,
) {
  const originalChanges = toProposedChanges(session, changes);
  await settleWorkspaceReview(
    {
      session,
      originalChanges,
      decisions: Object.fromEntries(
        changes.map((change) => [
          change.id,
          {
            accept: true,
            ...(change.proposalRevision
              ? { proposalRevision: change.proposalRevision }
              : {}),
            ...(change.newContent != null && !change.binary
              ? { content: change.newContent }
              : {}),
          },
        ]),
      ),
      sourceRevision,
      settlementError: null,
    },
    useProposedChangesStore.setState,
    true,
  );
}

async function settleWorkspaceReview(
  review: WorkspaceReview,
  set: (
    updater: (state: ProposedChangesState) => Partial<ProposedChangesState>,
  ) => void,
  automatic = false,
) {
  const workspaceSessionId = review.session.sessionId;
  const projectRoot = review.session.projectRoot;
  const projectKey = getProposedChangesProjectKey(projectRoot);
  if (!projectKey) return;
  const settlementDecisions: AgentWorkspaceDecision[] =
    review.originalChanges.flatMap((change) =>
      review.decisions[change.id]
        ? [{ changeId: change.id, ...review.decisions[change.id] }]
        : [],
    );
  if (!settlementDecisions.length) return;
  const inlineChanges = review.originalChanges.filter(
    (change) =>
      !review.decisions[change.id] && change.reviewedContent !== undefined,
  );
  const hasAcceptedChange =
    inlineChanges.length > 0 ||
    settlementDecisions.some((decision) => decision.accept);
  let historyInitializationError: string | null = null;
  const { useAgentReviewQueueStore } = await import(
    "./agent-review-queue-store"
  );
  const { useAgentChatStore: archiveChatStore } = await import(
    "./agent-chat-store"
  );
  // Manual acceptance must not race paused-chat archive cleanup.
  if (
    !automatic &&
    archiveChatStore
      .getState()
      .tabs.some((tab) => tab.id === review.session.tabId && tab.isSettling)
  )
    return;
  const queue = useAgentReviewQueueStore.getState();
  const queued = queue.entries.find(
    (entry) => entry.session.sessionId === workspaceSessionId,
  );
  if (queued && queued.phase !== (automatic ? "applying" : "review")) return;
  if (queued && (await queue.checkProject(workspaceSessionId))) return;
  if (
    queued &&
    useAgentReviewQueueStore
      .getState()
      .entries.find((entry) => entry.session.sessionId === workspaceSessionId)
      ?.phase !== (automatic ? "applying" : "review")
  )
    return;
  if (useDocumentStore.getState().projectRoot !== projectRoot) return;
  if (queued)
    useAgentReviewQueueStore.setState((state) => ({
      entries: state.entries.map((entry) =>
        entry.session.sessionId === workspaceSessionId
          ? { ...entry, phase: "applying" }
          : entry,
      ),
    }));
  if (!automatic)
    set((current) => ({
      workspaceReview: current.workspaceReview
        ? { ...current.workspaceReview, isApplying: true }
        : null,
    }));
  if (hasAcceptedChange) {
    await useHistoryStore
      .getState()
      .init(projectRoot)
      .catch((error) => {
        historyInitializationError = String(error);
        log.warn("Failed to initialize history before applying agent draft", {
          error: historyInitializationError,
        });
      });
  }
  let result: Awaited<ReturnType<typeof applyAgentWorkspace>>;
  try {
    await flushWorkspaceState();
    const draftDoc = useDocumentStore.getState();
    if (draftDoc.agentWorkspaceSessionId === workspaceSessionId) {
      for (const change of review.originalChanges) {
        if (
          review.decisions[change.id] ||
          change.binary ||
          change.workspaceChangeKind === "deleted" ||
          (change.conflictContents &&
            !change.resolvedConflict &&
            change.reviewedContent === undefined)
        )
          continue;
        const file = draftDoc.files.find(
          (item) => item.relativePath === change.filePath,
        );
        if (file?.content == null || file.content === change.newContent)
          continue;
        if (
          file.externalChange ||
          !file.absolutePath.startsWith(`${review.session.candidateRoot}/`)
        )
          throw new Error(
            `Resolve the draft change in ${change.filePath} before applying another file.`,
          );
        await writeTexFileContent(
          file.absolutePath,
          encodeDocumentText(file.content, file.diskContent ?? ""),
        );
      }
    }
    // Applying another file also refreshes the review. Commit inline baselines
    // in the same transaction so that refresh cannot discard those decisions.
    if (inlineChanges.length) {
      const fresh = await previewAgentWorkspace(
        projectRoot,
        workspaceSessionId,
      );
      if (fresh.sourceRevision !== review.sourceRevision)
        throw new Error(
          "The source project changed. Check the draft again before applying.",
        );
      for (const previous of inlineChanges) {
        const change = fresh.changes.find(
          (item) => item.filePath === previous.filePath,
        );
        if (!change) continue;
        settlementDecisions.push({
          changeId: change.id,
          accept: true,
          partial: true,
          resolvedConflict: true,
          proposalRevision: change.proposalRevision,
          content: previous.reviewedContent,
        });
      }
    }
    if (hasAcceptedChange) {
      const doc = useDocumentStore.getState();
      if (doc.projectRoot !== projectRoot)
        throw new Error("Open the draft's project before applying changes.");
      if (!doc.agentWorkspaceRoot)
        await doc.saveAllFiles({ requireClean: true });
      if (
        useDocumentStore
          .getState()
          .sourceViewSnapshot?.files.some(
            (file) => file.isDirty || file.externalChange,
          )
      )
        throw new Error(
          "Save or resolve your source edits before applying this draft.",
        );
      if (automatic && useDocumentStore.getState().projectRoot !== projectRoot)
        throw new Error("Open the draft's project before applying changes.");
      await synchronizeProjectCommentAnchors(projectRoot).catch((error) => {
        log.warn(
          "Comment references could not be prepared; source application will continue",
          { error: String(error) },
        );
      });
      useDocumentStore.setState({ isApplyingAgentDraft: true });
      result = await applyAgentWorkspace(
        projectRoot,
        review.session.sessionId,
        settlementDecisions,
        review.sourceRevision,
        queued?.preview?.projectRevision,
      );
    } else {
      result = await applyAgentWorkspace(
        projectRoot,
        review.session.sessionId,
        settlementDecisions,
        review.sourceRevision,
        queued?.preview?.projectRevision,
      );
    }
  } catch (error) {
    useDocumentStore.setState({ isApplyingAgentDraft: false });
    if (queued && String(error).includes("project_changed:")) {
      await queue.interruptReview(workspaceSessionId);
      return;
    }
    log.error("Failed to settle isolated agent workspace", {
      error: String(error),
    });
    const { useAgentChatStore } = await import("./agent-chat-store");
    useAgentChatStore
      .getState()
      ._setError(
        review.session.tabId,
        `The draft transaction failed. ${PRODUCT_NAME} attempted to roll back any partial source writes; review the error before retrying. ${String(error)}`,
      );
    if (!automatic)
      set((current) => {
        const restoredReview: WorkspaceReview = {
          ...review,
          settlementError: String(error),
          isApplying: false,
        };
        const changesByProject = {
          ...current.changesByProject,
          [projectKey]: review.originalChanges,
        };
        return {
          changesByProject,
          workspaceReviewsByProject: {
            ...current.workspaceReviewsByProject,
            [projectKey]: restoredReview,
          },
          ...(current.activeProjectRoot === projectKey
            ? {
                changes: review.originalChanges,
                workspaceReview: restoredReview,
              }
            : {}),
        };
      });
    if (queued) {
      useAgentReviewQueueStore.setState((state) => ({
        entries: state.entries.map((entry) =>
          entry.session.sessionId === workspaceSessionId
            ? { ...entry, phase: "question", error: String(error) }
            : entry,
        ),
      }));
    }
    return;
  }

  useDocumentStore.setState({ isApplyingAgentDraft: false });
  if (!result.applied) {
    if (
      queued &&
      result.conflicts.some((conflict) =>
        conflict.reason.startsWith("Source changed since review"),
      )
    ) {
      await queue.interruptReview(workspaceSessionId);
      return;
    }
    const message = result.conflicts
      .map((conflict) => `${conflict.filePath}: ${conflict.reason}`)
      .join("\n");
    const { useAgentChatStore } = await import("./agent-chat-store");
    useAgentChatStore
      .getState()
      ._setError(
        review.session.tabId,
        `The source changed while the draft was open. No source files were changed.\n${message}`,
      );
    if (!automatic)
      set((current) => {
        const restoredReview: WorkspaceReview = {
          ...review,
          isApplying: false,
          settlementError:
            message || "The source changed while the agent was working.",
        };
        return {
          changesByProject: {
            ...current.changesByProject,
            [projectKey]: review.originalChanges,
          },
          workspaceReviewsByProject: {
            ...current.workspaceReviewsByProject,
            [projectKey]: restoredReview,
          },
          ...(current.activeProjectRoot === projectKey
            ? {
                changes: review.originalChanges,
                workspaceReview: restoredReview,
              }
            : {}),
        };
      });
    if (queued && automatic) {
      useAgentReviewQueueStore.setState((state) => ({
        entries: state.entries.map((entry) =>
          entry.session.sessionId === workspaceSessionId
            ? {
                ...entry,
                phase: "question",
                conflicts: result.conflicts,
                error:
                  message ||
                  "The source changed before automatic application. Check the draft again.",
              }
            : entry,
        ),
      }));
    } else if (queued) await queue.recheck(review.session.sessionId);
    return;
  }

  const postApplyErrors: string[] = [];
  const sourceUpdated = result.changedPaths.length > 0;
  const documentStore = useDocumentStore.getState();
  if (
    documentStore.projectRoot === projectRoot &&
    (!documentStore.agentWorkspaceSessionId ||
      documentStore.agentWorkspaceSessionId === review.session.sessionId)
  ) {
    await documentStore
      .restoreSourceWorkspace(result.changedPaths, {
        preserveSelection: true,
        ...(result.remainingPreview
          ? {
              pendingReviewPaths: result.remainingPreview.changes.map(
                (change) => change.filePath,
              ),
            }
          : {}),
      })
      .catch((error) => {
        postApplyErrors.push(
          `could not restore the source view: ${String(error)}`,
        );
      });
  }
  if (sourceUpdated) {
    await synchronizeProjectCommentAnchors(projectRoot).catch((error) => {
      postApplyErrors.push(
        `document saved, but comment positions need recovery: ${String(error)}`,
      );
    });
    if (historyInitializationError) {
      postApplyErrors.push(
        `could not initialize history: ${historyInitializationError}`,
      );
    }
    if (!historyInitializationError) {
      await useHistoryStore
        .getState()
        .createSnapshot(
          projectRoot,
          `[${review.session.mode}] After accepted agent edit`,
        )
        .catch((error) => {
          postApplyErrors.push(`could not record history: ${String(error)}`);
        });
    }
  }
  const { useAgentChatStore } = await import("./agent-chat-store");
  const chatStore = useAgentChatStore.getState();
  if (!automatic) {
    await chatStore
      ._recordReviewDecision(review.session.tabId, {
        uuid: `draft-review-${review.session.sessionId}-${Date.now()}`,
        type: "system",
        subtype: "draft_review_decisions",
        message: {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                review.originalChanges
                  .filter((change) => review.decisions[change.id])
                  .map((change) => ({
                    path: change.filePath,
                    kind: change.workspaceChangeKind,
                    decision: review.decisions[change.id]?.accept
                      ? "accepted"
                      : "rejected",
                    ...(review.decisions[change.id]?.accept
                      ? {}
                      : {
                          proposed: change.binary
                            ? "Non-text proposal rejected; it was not applied."
                            : change.newContent,
                        }),
                  })),
              ),
            },
          ],
        },
      })
      .catch((error) => {
        postApplyErrors.push(`could not save review history: ${String(error)}`);
      });
  }
  if (result.remainingPreview?.changes.length) {
    const remaining = result.remainingPreview;
    const { useAgentChatStore } = await import("./agent-chat-store");
    useAgentChatStore
      .getState()
      ._setAgentWorkspace(review.session.tabId, remaining.session);
    useAgentReviewQueueStore.setState((state) => ({
      entries: state.entries.map((entry) =>
        entry.session.sessionId === workspaceSessionId
          ? {
              ...entry,
              session: remaining.session,
              preview: remaining,
              conflicts: remaining.conflicts,
              phase: remaining.conflicts.some(
                (conflict) => !remaining.conflictContents?.[conflict.changeId],
              )
                ? "question"
                : "review",
              editedContents: undefined,
              excludedChangeIds: undefined,
              error: postApplyErrors.length
                ? postApplyErrors.join("; ")
                : undefined,
            }
          : entry,
      ),
    }));
    if (
      remaining.conflicts.some(
        (conflict) => !remaining.conflictContents?.[conflict.changeId],
      )
    )
      useProposedChangesStore.getState().clearWorkspaceReview(projectRoot);
    else await useAgentReviewQueueStore.getState().show(workspaceSessionId);
    await flushWorkspaceState();
    return;
  }
  const cleanupError = await retireAgentDraft(review.session, {
    settled: true,
  });
  if (cleanupError) {
    log.warn("Failed to remove settled agent workspace", {
      error: String(cleanupError),
    });
    postApplyErrors.push(
      `could not remove the settled draft: ${String(cleanupError)}`,
    );
  }
  if (postApplyErrors.length > 0) {
    chatStore._setError(
      review.session.tabId,
      sourceUpdated
        ? `The source was updated, but ${PRODUCT_NAME} ${postApplyErrors.join("; ")}.`
        : `The draft was settled without changing source files, but ${PRODUCT_NAME} ${postApplyErrors.join("; ")}.`,
    );
  }
  if (queued) await queue.finish(review.session.sessionId);
}

function toProposedChanges(
  session: AgentWorkspaceSession,
  workspaceChanges: AgentWorkspaceChange[],
): ProposedChange[] {
  return workspaceChanges.map((change) => ({
    id: change.id,
    filePath: change.filePath,
    absolutePath: change.candidateAbsolutePath ?? change.sourceAbsolutePath,
    oldContent: normalizeDocumentText(change.oldContent ?? ""),
    newContent: normalizeDocumentText(change.newContent ?? ""),
    toolName: `Agent ${change.kind}`,
    timestamp: Date.now(),
    workspaceSessionId: session.sessionId,
    workspaceChangeKind: change.kind,
    oldFilePath: change.oldFilePath,
    newFilePath: change.newFilePath,
    binary: change.binary,
    sourceAbsolutePath: change.sourceAbsolutePath,
    sourceChanged: change.sourceChanged,
    proposalRevision: change.proposalRevision,
    conflictMissingVersions: [
      ...(change.ancestorContent === null ? ["ancestor" as const] : []),
      ...(change.oldContent === null ? ["current" as const] : []),
      ...(change.newContent === null ? ["agent" as const] : []),
    ],
  }));
}

export const useProposedChangesStore = create<ProposedChangesState>()(
  persist(
    (set, get) => ({
      changes: [],
      activeProjectRoot: null,
      changesByProject: {},
      workspaceReviewsByProject: {},
      workspaceReview: null,

      activateProject: (projectRoot) => {
        const normalizedRoot = getProposedChangesProjectKey(projectRoot);
        set((state) => ({
          activeProjectRoot: normalizedRoot,
          changes: normalizedRoot
            ? [...(state.changesByProject[normalizedRoot] ?? [])]
            : [],
          workspaceReview: normalizedRoot
            ? (state.workspaceReviewsByProject[normalizedRoot] ?? null)
            : null,
        }));
      },

      startWorkspaceReview: (
        session,
        workspaceChanges,
        sourceRevision,
        conflictContents,
      ) => {
        const projectKey = getProposedChangesProjectKey(session.projectRoot);
        if (!projectKey) return;
        const allChanges = toProposedChanges(session, workspaceChanges).map(
          (change) =>
            normalizeReviewText({
              ...change,
              conflictContents: conflictContents?.[change.id],
            }),
        );
        set((state) => {
          const existing = state.workspaceReviewsByProject[projectKey];
          const sameSession = existing?.session.sessionId === session.sessionId;
          const samePreview =
            sameSession &&
            sourceRevision !== undefined &&
            existing.sourceRevision === sourceRevision;
          // A decision is valid only for the exact proposal and source reviewed.
          if (sameSession) {
            for (const change of allChanges) {
              const previous = existing.originalChanges.find(
                (item) => item.id === change.id,
              );
              if (
                previous &&
                previous.proposalRevision === change.proposalRevision &&
                previous.oldContent === change.oldContent &&
                JSON.stringify(previous.conflictContents) ===
                  JSON.stringify(change.conflictContents)
              ) {
                Object.assign(change, {
                  resolvedConflict: previous.resolvedConflict,
                  deleteFile: previous.deleteFile,
                  reviewedContent: previous.reviewedContent,
                  ...(previous.resolvedConflict
                    ? { newContent: previous.newContent }
                    : {}),
                });
              }
            }
          }
          const preserveDecisions = samePreview;
          let decisions = preserveDecisions
            ? Object.fromEntries(
                Object.entries(existing.decisions).filter(([id]) => {
                  const before = existing.originalChanges.find(
                    (change) => change.id === id,
                  );
                  const after = allChanges.find((change) => change.id === id);
                  return (
                    before &&
                    after &&
                    before.proposalRevision === after.proposalRevision &&
                    before.oldContent === after.oldContent &&
                    before.newContent === after.newContent
                  );
                }),
              )
            : {};
          if (
            !samePreview &&
            allChanges.length > 0 &&
            allChanges.every((change) =>
              Object.prototype.hasOwnProperty.call(decisions, change.id),
            )
          ) {
            decisions = {};
          }
          const changes = allChanges.filter(
            (change) =>
              !Object.prototype.hasOwnProperty.call(decisions, change.id),
          );
          const review: WorkspaceReview = {
            session,
            sourceRevision,
            originalChanges: allChanges,
            decisions,
            settlementError: preserveDecisions
              ? existing.settlementError
              : null,
          };
          return {
            activeProjectRoot: projectKey,
            changes,
            changesByProject: {
              ...state.changesByProject,
              [projectKey]: changes,
            },
            workspaceReview: review,
            workspaceReviewsByProject: {
              ...state.workspaceReviewsByProject,
              [projectKey]: review,
            },
          };
        });
      },

      resolveConflict: (id, content, deleteFile = false) => {
        set((state) =>
          updateConflictChange(state, id, (change) => ({
            ...change,
            newContent: normalizeDocumentText(content),
            resolvedConflict: true,
            deleteFile,
          })),
        );
      },
      clearWorkspaceReview: (projectRoot) => {
        const projectKey = getProposedChangesProjectKey(projectRoot);
        if (!projectKey) return;
        set((state) => {
          const changesByProject = { ...state.changesByProject };
          const workspaceReviewsByProject = {
            ...state.workspaceReviewsByProject,
          };
          const projectChanges = changesByProject[projectKey] ?? [];
          const remainingChanges = projectChanges.filter(
            (change) => !change.workspaceSessionId,
          );
          if (remainingChanges.length > 0) {
            changesByProject[projectKey] = remainingChanges;
          } else {
            delete changesByProject[projectKey];
          }
          delete workspaceReviewsByProject[projectKey];
          const isActive = state.activeProjectRoot === projectKey;
          return {
            changesByProject,
            workspaceReviewsByProject,
            ...(isActive
              ? {
                  changes: remainingChanges,
                  workspaceReview: null,
                }
              : {}),
          };
        });
      },

      setReviewedContent: (id, content) => {
        set((state) => {
          const change = state.changes.find((item) => item.id === id);
          const review = state.workspaceReview;
          if (
            !change?.workspaceSessionId ||
            !review ||
            review.isApplying ||
            change.reviewedContent === content
          )
            return {};
          const update = (item: ProposedChange) =>
            item.id === id ? { ...item, reviewedContent: content } : item;
          const next = {
            ...review,
            originalChanges: review.originalChanges.map(update),
          };
          return {
            ...updateActiveProjectChanges(state, state.changes.map(update)),
            workspaceReview: next,
            workspaceReviewsByProject: {
              ...state.workspaceReviewsByProject,
              [state.activeProjectRoot!]: next,
            },
          };
        });
      },

      addChange: (change) => {
        change = normalizeReviewText(change);
        log.debug(`Adding change: ${change.toolName} on ${change.filePath}`);
        set((state) => {
          // If there's already a pending change for the same file, merge them:
          // keep the original oldContent (true baseline), use the new newContent and id
          const existingIdx = state.changes.findIndex(
            (c) => c.filePath === change.filePath,
          );
          if (existingIdx >= 0) {
            const existing = state.changes[existingIdx];
            const merged: ProposedChange = {
              ...change,
              oldContent: existing.oldContent, // preserve original baseline
              timestamp: Date.now(),
            };
            const newChanges = [...state.changes];
            newChanges[existingIdx] = merged;
            return updateActiveProjectChanges(state, newChanges);
          }
          return updateActiveProjectChanges(state, [
            ...state.changes,
            { ...change, timestamp: Date.now() },
          ]);
        });
      },

      resolveChange: (id) => {
        set((state) =>
          updateActiveProjectChanges(
            state,
            state.changes.filter(
              (change) => change.workspaceSessionId || change.id !== id,
            ),
          ),
        );
      },

      resolveChangesForFiles: (filePaths) => {
        if (filePaths.length === 0) return;
        const committedPaths = new Set(
          filePaths.map((path) => path.replace(/\\/g, "/")),
        );
        set((state) =>
          updateActiveProjectChanges(
            state,
            state.changes.filter(
              (change) =>
                change.workspaceSessionId ||
                !committedPaths.has(change.filePath.replace(/\\/g, "/")),
            ),
          ),
        );
      },

      keepChange: async (id) => {
        const change = get().changes.find((c) => c.id === id);
        if (!change || (change.conflictContents && !change.resolvedConflict))
          return;

        // The caller (editor) already set the correct content via setContent().
        // Write the document store content to disk to stay in sync
        // (handles partial chunk resolution where finalContent differs from disk).
        const file = useDocumentStore
          .getState()
          .files.find((f) => f.relativePath === change.filePath);
        if (change.workspaceSessionId) {
          await settleWorkspaceDecision(
            id,
            true,
            change.binary ? undefined : file?.content,
            get,
            set,
          );
          return;
        }
        // Match rejection: settle the UI before asynchronous persistence so a
        // render cannot reactivate the proposal and reset its cursor/history.
        const settle = () =>
          set((state) =>
            updateActiveProjectChanges(
              state,
              state.changes.filter((c) => c.id !== id),
            ),
          );
        try {
          await saveReviewedSource(
            change,
            file?.content ?? change.newContent,
            settle,
          );
        } catch (err) {
          log.error("Failed to write kept change", { error: String(err) });
          toast.error(`The accepted edit could not be saved: ${String(err)}`);
        }
      },

      undoChange: async (id) => {
        const change = get().changes.find((c) => c.id === id);
        if (!change) return;

        log.info(`Undoing change on ${change.filePath}`);
        if (change.workspaceSessionId) {
          await settleWorkspaceDecision(id, false, undefined, get, set);
          return;
        }
        // Resolve the UI state synchronously. Disk restore/reload can finish
        // after merge view teardown, but the same change must not reactivate.
        const settle = () =>
          set((state) =>
            updateActiveProjectChanges(
              state,
              state.changes.filter((c) => c.id !== id),
            ),
          );

        // Restore oldContent to disk
        await saveReviewedSource(change, change.oldContent, settle);
      },

      settleIfReviewed: async () => {
        const { workspaceReview: review, changes } = get();
        if (
          review &&
          !review.isApplying &&
          review.originalChanges.length > 0 &&
          !changes.some(
            (change) => change.workspaceSessionId === review.session.sessionId,
          )
        )
          await settleWorkspaceReview(review, set);
      },
      keepAll: async () => {
        const { changes } = get();
        if (changes.some((change) => change.workspaceSessionId)) {
          for (const change of changes) {
            if (change.conflictContents && !change.resolvedConflict) continue;
            const file = useDocumentStore
              .getState()
              .files.find((item) => item.relativePath === change.filePath);
            await settleWorkspaceDecision(
              change.id,
              true,
              change.binary ? undefined : file?.content,
              get,
              set,
              false,
            );
          }
          const review = get().workspaceReview;
          if (review) await settleWorkspaceReview(review, set);
          return;
        }
        for (const change of changes) {
          await get().keepChange(change.id);
          // A validation failure retains its proposal; a failed write retains
          // its dirty buffer. Do not settle unrelated files past either one.
          if (
            get().changes.some((item) => item.id === change.id) ||
            useDocumentStore
              .getState()
              .files.some(
                (file) => file.relativePath === change.filePath && file.isDirty,
              )
          )
            break;
        }
      },

      undoAll: async () => {
        const { changes } = get();
        log.info(`Undoing all ${changes.length} changes`);
        if (changes.some((change) => change.workspaceSessionId)) {
          for (const change of changes) {
            await settleWorkspaceDecision(
              change.id,
              false,
              undefined,
              get,
              set,
              false,
            );
          }
          const review = get().workspaceReview;
          if (review) await settleWorkspaceReview(review, set);
          return;
        }
        // Settle each decision before its write, retaining later proposals when
        // a write fails or the workspace changes partway through the batch.
        for (const change of changes) {
          await get().undoChange(change.id);
        }
      },

      getChangeForFile: (relativePath) => {
        return get().changes.find((c) => c.filePath === relativePath);
      },
    }),
    {
      name: PROPOSED_CHANGES_STORAGE_KEY,
      ...workspaceStatePersistence,
      version: 1,
      partialize: (state) => ({
        changesByProject: state.changesByProject,
        workspaceReviewsByProject: state.workspaceReviewsByProject,
      }),
      merge: (persisted, current) => {
        const saved = persisted as
          | Pick<
              ProposedChangesState,
              "changesByProject" | "workspaceReviewsByProject"
            >
          | undefined;
        const changesByProject =
          saved?.changesByProject ?? current.changesByProject;
        const workspaceReviewsByProject =
          saved?.workspaceReviewsByProject ?? current.workspaceReviewsByProject;
        const root = current.activeProjectRoot;
        // An unrelated window's save must not unlock this window's settlement.
        const isApplying = current.workspaceReview?.isApplying;
        return {
          ...current,
          changesByProject,
          workspaceReviewsByProject,
          changes: isApplying
            ? current.changes
            : root
              ? [...(changesByProject[root] ?? [])]
              : [],
          workspaceReview: isApplying
            ? current.workspaceReview
            : root
              ? (workspaceReviewsByProject[root] ?? null)
              : null,
        };
      },
    },
  ),
);

synchronizePersistedStore(useProposedChangesStore);

/** Navigate only after the file decision has finished refreshing the draft. */
export async function settleFileReview(id: string, accept: boolean) {
  const store = useProposedChangesStore.getState();
  const change = store.changes.find((item) => item.id === id);
  if (!change) return;
  const before = useDocumentStore.getState();
  await (accept ? store.keepChange(id) : store.undoChange(id));
  const doc = useDocumentStore.getState();
  const review = useProposedChangesStore.getState();
  if (
    doc.projectRoot !== before.projectRoot ||
    doc.fileSelectionRevision !== before.fileSelectionRevision ||
    (change.workspaceSessionId &&
      doc.agentWorkspaceSessionId !== change.workspaceSessionId) ||
    review.workspaceReview?.settlementError ||
    review.changes.some((item) => item.id === id)
  )
    return;
  const next = review.changes.find((item) =>
    doc.files.some((file) => file.relativePath === item.filePath),
  );
  if (next) doc.setActiveFile(next.filePath);
}

/** Recheck immediately before a Git mutation, including after async preparation. */
export function assertGitReviewFinished(): void {
  const review = useProposedChangesStore.getState();
  if (review.changes.length > 0 || review.workspaceReview) {
    throw new Error("Finish agent review to use Git actions.");
  }
}
