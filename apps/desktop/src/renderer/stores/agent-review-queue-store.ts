import { createPanelStore } from "@/lib/panel-window-runtime";
import { normalizeDocumentText, encodeDocumentText } from "@/lib/document-text";
import { invoke } from "@/lib/desktop/core";
import { retireAgentDraft } from "@/lib/retire-agent-draft";
import {
  workspaceStatePersistence,
  flushWorkspaceState,
} from "@/lib/workspace-state-storage";
import { persist } from "zustand/middleware";
import { synchronizePersistedStore } from "@/lib/persisted-store-sync";
import {
  type AgentWorkspaceSession,
  type AgentWorkspaceConflict,
  type AgentWorkspacePreview,
  previewAgentWorkspace,
  resumeAgentWorkspace,
  reconcileAgentWorkspace,
  applyAgentWorkspace,
  readReviewProjectState,
} from "@/lib/agent-workspace";
import { writeTexFileContent } from "@/lib/project-files";
import { useDocumentStore } from "./document-store";
import { useAgentChatStore } from "./agent-chat-store";
import {
  applyWorkspaceAutomatically,
  useProposedChangesStore,
  getProposedChangesProjectKey,
} from "./proposed-changes-store";

export interface ReviewQueueEntry {
  session: AgentWorkspaceSession;
  phase:
    | "queued"
    | "checking"
    | "question"
    | "review"
    | "revising"
    | "applying";
  conflicts: AgentWorkspaceConflict[];
  preview?: AgentWorkspacePreview;
  error?: string;
  // Persist across queue delays and rechecks; source checks do not recompile.
  verificationError?: string;
  editedContents?: Record<string, string>;
  excludedChangeIds?: string[];
  refinementDecisions?: Record<
    string,
    { accept: boolean; revision: string; content?: string }
  >;
  refinementRound?: number;
  projectChangePending?: boolean;
  interrupted?: boolean;
}

function previewDecisions(entry: ReviewQueueEntry) {
  const contents = Object.fromEntries(
    (entry.preview?.changes ?? []).flatMap((change) =>
      change.newContent != null && !change.binary
        ? [[change.id, change.newContent]]
        : [],
    ),
  );
  return Object.entries({ ...contents, ...entry.editedContents }).map(
    ([changeId, content]) => ({ changeId, content, accept: true }),
  );
}

function reviewChanges(
  preview: AgentWorkspacePreview,
  editedContents?: Record<string, string>,
) {
  return preview.changes
    .filter(
      (change) =>
        !preview.conflicts.some(
          (conflict) => conflict.changeId === change.id,
        ) || !!preview.conflictContents?.[change.id],
    )
    .map((change) => ({
      ...change,
      ancestorContent: change.oldContent,
      oldContent: Object.prototype.hasOwnProperty.call(
        preview.currentContents,
        change.id,
      )
        ? preview.currentContents[change.id]
        : change.oldContent,
      newContent:
        editedContents?.[change.id] ??
        (Object.prototype.hasOwnProperty.call(preview.mergedContents, change.id)
          ? preview.mergedContents[change.id]
          : change.newContent),
    }));
}

function changeVersion(change: AgentWorkspacePreview["changes"][number]) {
  // Older backends cannot safely preserve binary approvals.
  return (
    change.proposalRevision ??
    (!change.binary
      ? JSON.stringify([
          change.kind,
          change.oldFilePath,
          change.newFilePath,
          change.newContent,
        ])
      : "")
  );
}
function changeKey(change: AgentWorkspacePreview["changes"][number]) {
  return JSON.stringify([
    change.kind,
    change.oldFilePath,
    change.newFilePath,
    change.filePath,
  ]);
}
const processing = new Set<string>();

const create = createPanelStore("reviews");
export const useAgentReviewQueueStore = create<{
  entries: ReviewQueueEntry[];
  captureEdits: () => void;
  beginRefinement: (
    sessionId: string,
  ) => Promise<{ session: AgentWorkspaceSession; instructions: string }>;
  recoverRefinement: (sessionId: string) => Promise<void>;
  enqueue: (
    session: AgentWorkspaceSession,
    verificationError?: string,
  ) => Promise<void>;
  advance: (projectRoot: string) => Promise<void>;
  show: (sessionId: string) => Promise<void>;
  finish: (sessionId: string) => Promise<void>;
  recheck: (sessionId: string) => Promise<void>;
  checkProject: (sessionId: string) => Promise<boolean>;
  interruptReview: (sessionId: string) => Promise<void>;
  acknowledgeProjectChange: (sessionId: string) => Promise<void>;
  answer: (sessionId: string, answer: string) => Promise<void>;
}>()(
  persist(
    (set, get) => ({
      entries: [],
      checkProject: async (sessionId) => {
        const entry = get().entries.find(
          (item) => item.session.sessionId === sessionId,
        );
        if (!entry || entry.interrupted) return Boolean(entry?.interrupted);
        if (!entry.preview?.projectRevision) return false;
        let changed = true;
        try {
          const current = await readReviewProjectState(
            entry.session.projectRoot,
          );
          changed =
            current.gitPending ||
            current.revision !== entry.preview.projectRevision;
        } catch {
          // An unreadable source cannot authorize publication of a stale review.
        }
        const latest = get().entries.find(
          (item) => item.session.sessionId === sessionId,
        );
        if (
          useDocumentStore.getState().projectRoot !== entry.session.projectRoot
        )
          return false;
        if (
          latest?.preview !== entry.preview ||
          latest?.phase !== entry.phase ||
          latest?.interrupted
        )
          return Boolean(latest?.interrupted);
        if (changed) await get().interruptReview(sessionId);
        return changed;
      },
      interruptReview: async (sessionId) => {
        const entry = get().entries.find(
          (item) => item.session.sessionId === sessionId,
        );
        if (!entry || entry.interrupted) return;
        get().captureEdits();
        set((state) => ({
          entries: state.entries.map((item) =>
            item.session.sessionId === sessionId
              ? {
                  ...item,
                  phase: "question",
                  interrupted: true,
                  projectChangePending: true,
                  refinementDecisions: undefined,
                  error:
                    "The project changed outside this review. Check the saved draft again before continuing.",
                }
              : item,
          ),
        }));
        useAgentChatStore.setState((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === entry.session.tabId
              ? { ...tab, promptQueuePaused: true }
              : tab,
          ),
        }));
        useProposedChangesStore
          .getState()
          .clearWorkspaceReview(entry.session.projectRoot);
        // Leave the candidate read-only behind the modal. Restoring the normal
        // source view is an explicit acknowledgement, never a queue advance.
        if (useDocumentStore.getState().agentWorkspaceSessionId === sessionId)
          useDocumentStore.getState().setAgentWorkspaceReadOnly(true);
        await flushWorkspaceState();
      },
      acknowledgeProjectChange: async (sessionId) => {
        const entry = get().entries.find(
          (item) => item.session.sessionId === sessionId,
        );
        if (
          !entry?.projectChangePending ||
          useDocumentStore.getState().projectRoot !== entry.session.projectRoot
        )
          return;
        const doc = useDocumentStore.getState();
        if (doc.agentWorkspaceSessionId === sessionId)
          await doc.restoreSourceWorkspace();
        else await doc.refreshFiles();
        if (
          useDocumentStore.getState().projectRoot !== entry.session.projectRoot
        )
          return;
        const { ensureConflictFiles } = await import("@/lib/git-conflicts");
        const git = await invoke<{ repo_found: boolean }>("git_panel_status", {
          projectRoot: entry.session.projectRoot,
        });
        if (git.repo_found)
          await ensureConflictFiles(
            entry.session.projectRoot,
            () =>
              useDocumentStore.getState().projectRoot ===
              entry.session.projectRoot,
          );
        window.dispatchEvent(new CustomEvent("catalex:git-stats-refresh"));
        set((state) => ({
          entries: state.entries.map((item) =>
            item.session.sessionId === sessionId
              ? { ...item, projectChangePending: false }
              : item,
          ),
        }));
        await flushWorkspaceState();
      },
      beginRefinement: async (sessionId) => {
        if (await get().checkProject(sessionId))
          throw new Error(
            "The project changed. Return to the project before continuing.",
          );
        const entry = get().entries.find(
          (item) => item.session.sessionId === sessionId,
        );
        const doc = useDocumentStore.getState();
        const review = useProposedChangesStore.getState().workspaceReview;
        if (
          !entry ||
          entry.phase !== "review" ||
          !entry.preview ||
          get().entries.find(
            (item) => item.session.projectRoot === entry.session.projectRoot,
          ) !== entry ||
          doc.projectRoot !== entry.session.projectRoot ||
          doc.agentWorkspaceSessionId !== sessionId ||
          useAgentChatStore.getState().activeTabId !== entry.session.tabId ||
          review?.session.sessionId !== sessionId ||
          review.isApplying
        )
          throw new Error("Open the active draft review before refining it.");
        const update = (patch: Partial<ReviewQueueEntry>) =>
          set((state) => ({
            entries: state.entries.map((item) =>
              item.session.sessionId === sessionId
                ? { ...item, ...patch }
                : item,
            ),
          }));
        update({ phase: "revising", error: undefined });
        doc.setAgentWorkspaceReadOnly(true);
        const markPreparing = (isApplying: boolean) =>
          useProposedChangesStore.setState((state) => {
            const key = getProposedChangesProjectKey(
              entry.session.projectRoot,
            )!;
            const current = state.workspaceReviewsByProject[key];
            if (current?.session.sessionId !== sessionId) return {};
            const next = { ...current, isApplying };
            return {
              ...(state.activeProjectRoot === key
                ? { workspaceReview: next }
                : {}),
              workspaceReviewsByProject: {
                ...state.workspaceReviewsByProject,
                [key]: next,
              },
            };
          });
        const assertCurrentDraft = () => {
          const current = useDocumentStore.getState();
          if (
            current.projectRoot !== doc.projectRoot ||
            current.agentWorkspaceSessionId !== sessionId ||
            useAgentChatStore.getState().isLeavingProject
          )
            throw new Error(
              "The open workspace changed before refinement could start.",
            );
        };
        markPreparing(true);
        let sourceNeedsCheck = false;
        let appliedPaths: string[] = [];
        try {
          // Review buffers intentionally never autosave to source. Flush their exact
          // displayed contents to the candidate before resuming the agent.
          for (const file of doc.files) {
            if (file.content == null || file.isBinary) continue;
            const change = review.originalChanges.find(
              (change) => change.filePath === file.relativePath,
            );
            if (change?.workspaceChangeKind === "deleted") continue;
            if (file.externalChange)
              throw new Error(
                `Resolve the external change in ${file.relativePath} before refining.`,
              );
            if (
              !file.absolutePath.startsWith(`${entry.session.candidateRoot}/`)
            )
              throw new Error("The draft contains a file outside its sandbox.");
            await writeTexFileContent(
              file.absolutePath,
              encodeDocumentText(file.content, file.diskContent ?? ""),
            );
          }
          const current = useDocumentStore.getState();
          if (
            current.projectRoot !== doc.projectRoot ||
            current.agentWorkspaceSessionId !== sessionId
          )
            throw new Error(
              "The open workspace changed while saving the draft.",
            );
          let fresh = await previewAgentWorkspace(
            entry.session.projectRoot,
            sessionId,
          );
          if (fresh.sourceRevision !== review.sourceRevision) {
            sourceNeedsCheck = true;
            throw new Error(
              "The source project changed since this review. Check the draft again before refining.",
            );
          }
          assertCurrentDraft();
          const partialDecisions = fresh.changes.flatMap((change) => {
            const previous = review.originalChanges.find(
              (item) => item.filePath === change.filePath,
            );
            if (previous?.reviewedContent === undefined) return [];
            if (change.kind === "deleted" || change.binary)
              throw new Error(
                `Finish reviewing ${change.filePath} before refining its whole-file change.`,
              );
            return [
              {
                changeId: change.id,
                accept: true,
                partial: true,
                resolvedConflict: true,
                proposalRevision: change.proposalRevision,
                content: previous.reviewedContent,
              },
            ];
          });
          if (partialDecisions.length) {
            const applied = await applyAgentWorkspace(
              entry.session.projectRoot,
              sessionId,
              partialDecisions,
              fresh.sourceRevision,
              entry.preview.projectRevision,
            );
            if (!applied.applied) {
              sourceNeedsCheck = true;
              throw new Error(
                applied.conflicts
                  .map((conflict) => conflict.reason)
                  .join("\n") ||
                  "The source changed before inline decisions could be applied.",
              );
            }
            appliedPaths = applied.changedPaths;
            fresh =
              applied.remainingPreview ??
              (await previewAgentWorkspace(
                entry.session.projectRoot,
                sessionId,
              ));
            update({
              session: fresh.session,
              preview: fresh,
              conflicts: fresh.conflicts,
            });
            assertCurrentDraft();
            useProposedChangesStore
              .getState()
              .startWorkspaceReview(
                fresh.session,
                reviewChanges(fresh),
                fresh.sourceRevision,
                fresh.conflictContents,
              );
            markPreparing(true);
          }
          const refinementDecisions: NonNullable<
            ReviewQueueEntry["refinementDecisions"]
          > = {};
          const decisions = fresh.changes.flatMap((change) => {
            const previous = review.originalChanges.find(
              (item) => item.filePath === change.filePath,
            );
            const decision = previous && review.decisions[previous.id];
            if (!decision) return [];
            refinementDecisions[changeKey(change)] = {
              accept: decision.accept,
              revision: changeVersion(change),
              ...(change.binary || change.newContent == null
                ? {}
                : { content: change.newContent }),
            };
            return [
              {
                path: change.filePath,
                decision: decision.accept ? "approved" : "rejected",
                ...(decision.accept ? {} : { proposal: change.newContent }),
              },
            ];
          });
          assertCurrentDraft();
          await flushWorkspaceState();
          const session = await resumeAgentWorkspace(
            entry.session.projectRoot,
            sessionId,
            entry.session.tabId,
            entry.session.sharedSessionId,
          );
          update({
            session,
            refinementDecisions,
            refinementRound: (entry.refinementRound ?? 0) + 1,
            editedContents: undefined,
          });
          useDocumentStore.setState((state) =>
            state.agentWorkspaceSessionId !== sessionId
              ? {}
              : {
                  files: state.files.map((file) => ({
                    ...file,
                    isDirty: false,
                    diskContent:
                      file.content === undefined
                        ? file.diskContent
                        : encodeDocumentText(
                            file.content,
                            file.diskContent ?? "",
                          ),
                  })),
                },
          );
          // Refinement continues in the sandbox, but the workspace returns to
          // the source just as it does while an agent runs its first turn.
          await useDocumentStore
            .getState()
            .restoreSourceWorkspace(appliedPaths, { preserveSelection: true });
          useProposedChangesStore
            .getState()
            .clearWorkspaceReview(entry.session.projectRoot);
          return {
            session,
            instructions: `You are refining the SAME pending draft in its existing sandbox. Previously accepted portions are already applied to the source and review baseline; do not undo or repeat them.${session.baselineCommit ? ` Compare the sandbox against approved baseline commit ${session.baselineCommit} to identify only the remaining proposal.` : ""} The sandbox includes the user's latest manual edits; preserve them. Focus on the user's requested refinement. Preserve approved files unless a related change is necessary; any agent edits to them will require review again. Rejected proposals remain available here for context and must not be silently reinstated. Submit the revised draft for review.\nReview decisions: ${JSON.stringify(decisions)}\nPending conflicts: ${JSON.stringify(fresh.conflicts)}\nPending overlapping text (current is the latest user project; preserve its intent while refining your proposal): ${JSON.stringify(fresh.conflictContents ?? {})}`,
          };
        } catch (error) {
          update({
            phase: sourceNeedsCheck ? "question" : "review",
            error: String(error),
          });
          markPreparing(sourceNeedsCheck);
          if (useDocumentStore.getState().agentWorkspaceSessionId === sessionId)
            doc.setAgentWorkspaceReadOnly(sourceNeedsCheck);
          throw error;
        }
      },
      recoverRefinement: async (sessionId) => {
        const entry = get().entries.find(
          (item) => item.session.sessionId === sessionId,
        );
        if (!entry || entry.phase !== "revising") return;
        try {
          const result = await reconcileAgentWorkspace(
            entry.session.projectRoot,
            sessionId,
            "failed",
          );
          await get().enqueue(result.session);
        } catch (error) {
          set((state) => ({
            entries: state.entries.map((item) =>
              item === entry
                ? {
                    ...item,
                    phase: "question",
                    error: `The draft is preserved. Check again to recover review. ${String(error)}`,
                  }
                : item,
            ),
          }));
        }
      },
      captureEdits: () => {
        const doc = useDocumentStore.getState();
        set((state) => ({
          entries: state.entries.map((entry) => {
            if (
              entry.session.sessionId !== doc.agentWorkspaceSessionId ||
              !entry.preview
            )
              return entry;
            const editedContents = { ...entry.editedContents };
            for (const change of entry.preview.changes) {
              const file = doc.files.find(
                (file) =>
                  file.relativePath === (change.newFilePath ?? change.filePath),
              );
              if (
                file?.content !== undefined &&
                change.kind !== "deleted" &&
                file.content !==
                  normalizeDocumentText(
                    entry.preview.mergedContents[change.id] ?? "",
                  )
              )
                editedContents[change.id] = file.content;
            }
            return { ...entry, editedContents };
          }),
        }));
      },
      enqueue: async (session, verificationError) => {
        const refining = get().entries.find(
          (entry) =>
            entry.session.sessionId === session.sessionId &&
            entry.phase === "revising",
        );
        if (refining) {
          set((state) => ({
            entries: state.entries.map((entry) =>
              entry === refining
                ? {
                    ...entry,
                    session,
                    phase: "queued",
                    preview: undefined,
                    editedContents: undefined,
                    verificationError,
                  }
                : entry,
            ),
          }));
        }
        if (
          !get().entries.some(
            (entry) => entry.session.sessionId === session.sessionId,
          )
        ) {
          set((state) => ({
            entries: [
              ...state.entries,
              { session, phase: "queued", conflicts: [], verificationError },
            ],
          }));
        }
        await get().advance(session.projectRoot);
      },
      advance: async (projectRoot) => {
        if (processing.has(projectRoot)) return;
        const head = get().entries.find(
          (entry) => entry.session.projectRoot === projectRoot,
        );
        if (!head || head.phase !== "queued") return;
        processing.add(projectRoot);
        const id = head.session.sessionId;
        const update = (patch: Partial<ReviewQueueEntry>) =>
          set((state) => ({
            entries: state.entries.map((entry) =>
              entry.session.sessionId === id ? { ...entry, ...patch } : entry,
            ),
          }));
        try {
          update({ phase: "checking", error: undefined });
          const doc = useDocumentStore.getState();
          if (doc.projectRoot !== projectRoot) {
            update({ phase: "queued" });
            return;
          }
          // Flush source buffers before comparing; never save another agent's draft as source.
          if (!doc.agentWorkspaceRoot)
            await doc.saveAllFiles({ requireClean: true });
          const preview = await previewAgentWorkspace(
            projectRoot,
            id,
            previewDecisions(head),
          );
          if (useDocumentStore.getState().projectRoot !== projectRoot) {
            update({ phase: "queued" });
            return;
          }
          if (preview.changes.length === 0 && head.session.dirtyBuffers?.length)
            throw new Error(
              "This recovered draft contains unsaved editor text. Its sandbox has been retained; copy the text before discarding it.",
            );
          if (preview.changes.length === 0) {
            await retireAgentDraft(head.session);
            set((state) => ({
              entries: state.entries.filter(
                (entry) => entry.session.sessionId !== id,
              ),
            }));
          } else {
            update({
              preview,
              editedContents: undefined,
              conflicts: preview.conflicts,
              phase: preview.conflicts.some(
                (conflict) => !preview.conflictContents?.[conflict.changeId],
              )
                ? "question"
                : preview.conflicts.length
                  ? "review"
                  : head.session.mode === "edit" &&
                      !head.verificationError &&
                      !head.refinementRound
                    ? "applying"
                    : "review",
            });
            if (
              preview.conflicts.length &&
              preview.conflicts.every(
                (conflict) => preview.conflictContents?.[conflict.changeId],
              )
            ) {
              await get().show(id);
            } else if (!preview.conflicts.length) {
              if (
                head.session.mode === "edit" &&
                !head.verificationError &&
                !head.refinementRound
              ) {
                if (
                  head.session.status !== "review" ||
                  head.session.dirtyBuffers?.length
                ) {
                  update({
                    phase: "question",
                    error:
                      "This draft did not complete cleanly. Check or discard it before applying changes.",
                  });
                } else {
                  await applyWorkspaceAutomatically(
                    head.session,
                    preview.changes.map((change) => ({
                      ...change,
                      newContent: Object.prototype.hasOwnProperty.call(
                        preview.mergedContents,
                        change.id,
                      )
                        ? preview.mergedContents[change.id]
                        : change.newContent,
                    })),
                    preview.sourceRevision,
                  );
                }
              } else await get().show(id);
            }
          }
        } catch (error) {
          update({ phase: "question", error: String(error) });
        } finally {
          processing.delete(projectRoot);
        }
        if (!get().entries.some((entry) => entry.session.sessionId === id))
          await get().advance(projectRoot);
      },
      show: async (sessionId) => {
        const entry = get().entries.find(
          (entry) => entry.session.sessionId === sessionId,
        );
        if (!entry || entry.phase !== "review" || !entry.preview) return;
        const { session, preview } = entry;
        if (useDocumentStore.getState().projectRoot !== session.projectRoot)
          return;
        const changes = reviewChanges(preview, entry.editedContents);
        const doc = useDocumentStore.getState();
        if (doc.agentWorkspaceSessionId !== sessionId) {
          if (!doc.agentWorkspaceRoot)
            await doc.saveAllFiles({ requireClean: true });
          if (useDocumentStore.getState().projectRoot !== session.projectRoot)
            return;
          await doc.activateAgentWorkspace(sessionId, session.candidateRoot);
          if (
            useDocumentStore.getState().projectRoot !== session.projectRoot ||
            useDocumentStore.getState().agentWorkspaceSessionId !== sessionId
          )
            return;
          await useDocumentStore
            .getState()
            .addAgentWorkspaceReviewFiles(changes);
          if (
            useDocumentStore.getState().projectRoot !== session.projectRoot ||
            useDocumentStore.getState().agentWorkspaceSessionId !== sessionId
          )
            return;
          useDocumentStore.setState((state) => ({
            files: state.files.map((file) => {
              const change = changes.find(
                (change) =>
                  (change.newFilePath ?? change.filePath) === file.relativePath,
              );
              return change?.newContent != null
                ? {
                    ...file,
                    content: normalizeDocumentText(change.newContent),
                    isDirty: false,
                  }
                : file;
            }),
          }));
        }
        // Returning from refinement must reload disk, including unchanged files
        // edited by the agent outside the original proposal set.
        if (entry.refinementRound) {
          await useDocumentStore.getState().refreshFiles();
          await useDocumentStore
            .getState()
            .addAgentWorkspaceReviewFiles(changes);
          useDocumentStore.setState((state) => ({
            files: state.files.map((file) => {
              const change = changes.find(
                (item) =>
                  (item.newFilePath ?? item.filePath) === file.relativePath,
              );
              return change?.newContent != null
                ? {
                    ...file,
                    content: normalizeDocumentText(change.newContent),
                    isDirty: false,
                  }
                : file;
            }),
          }));
        }
        useDocumentStore.getState().setAgentWorkspaceReadOnly(false);
        // Refresh the editor's proposal text from captured review edits while
        // retaining decisions when reopening the same source revision.
        useProposedChangesStore
          .getState()
          .startWorkspaceReview(
            session,
            changes,
            preview.sourceRevision,
            preview.conflictContents,
          );
        if (entry.refinementDecisions) {
          useProposedChangesStore.setState((state) => {
            const review = state.workspaceReview;
            if (review?.session.sessionId !== sessionId) return {};
            const decisions = Object.fromEntries(
              changes.flatMap((change) => {
                const previous = entry.refinementDecisions?.[changeKey(change)];
                return previous?.revision &&
                  previous.revision === changeVersion(change)
                  ? [
                      [
                        change.id,
                        {
                          accept: previous.accept,
                          ...(change.binary || change.newContent == null
                            ? {}
                            : { content: change.newContent }),
                        },
                      ],
                    ]
                  : [];
              }),
            );
            const next = { ...review, decisions };
            const pending = review.originalChanges.filter(
              (change) =>
                !Object.prototype.hasOwnProperty.call(decisions, change.id),
            );
            return {
              workspaceReview: next,
              changes: pending,
              changesByProject: {
                ...state.changesByProject,
                [session.projectRoot]: pending,
              },
              workspaceReviewsByProject: {
                ...state.workspaceReviewsByProject,
                [session.projectRoot]: next,
              },
            };
          });
          set((state) => ({
            entries: state.entries.map((item) =>
              item.session.sessionId === sessionId
                ? { ...item, refinementDecisions: undefined }
                : item,
            ),
          }));
          await useProposedChangesStore.getState().settleIfReviewed();
        }
        const chat = useAgentChatStore.getState();
        if (
          chat.tabs.find((tab) => tab.id === session.tabId)?.queuedPrompts
            ?.length
        )
          void chat._runNextQueuedPrompt(session.tabId);
      },
      finish: async (sessionId) => {
        // Retirement is complete before removing the entry and advancing.
        const entry = get().entries.find(
          (entry) => entry.session.sessionId === sessionId,
        );
        if (!entry) return;
        set((state) => ({
          entries: state.entries.filter(
            (entry) => entry.session.sessionId !== sessionId,
          ),
        }));
        await get().advance(entry.session.projectRoot);
      },
      recheck: async (sessionId) => {
        const entry = get().entries.find(
          (entry) => entry.session.sessionId === sessionId,
        );
        if (!entry) return;
        if (entry.projectChangePending) return;
        if (entry.interrupted) {
          const current = await readReviewProjectState(
            entry.session.projectRoot,
          );
          if (current.gitPending)
            throw new Error(
              "Finish or abort the Git operation before checking this draft again.",
            );
        }
        if (entry.session.status === "active") {
          const result = await reconcileAgentWorkspace(
            entry.session.projectRoot,
            sessionId,
            "failed",
          );
          set((state) => ({
            entries: state.entries.map((item) =>
              item.session.sessionId === sessionId
                ? { ...item, session: result.session }
                : item,
            ),
          }));
          useAgentChatStore
            .getState()
            ._setAgentWorkspace(entry.session.tabId, result.session);
        }
        get().captureEdits();
        useProposedChangesStore
          .getState()
          .clearWorkspaceReview(entry.session.projectRoot);
        if (useDocumentStore.getState().agentWorkspaceSessionId === sessionId)
          await useDocumentStore.getState().restoreSourceWorkspace();
        set((state) => ({
          entries: state.entries.map((item) =>
            item.session.sessionId === sessionId
              ? {
                  ...item,
                  phase: "queued",
                  conflicts: [],
                  interrupted: false,
                  // Reopening an interrupted Edit-mode draft always requires review.
                  refinementRound: item.interrupted
                    ? (item.refinementRound ?? 0) + 1
                    : item.refinementRound,
                }
              : item,
          ),
        }));
        await get().advance(entry.session.projectRoot);
      },
      answer: async (sessionId, answer) => {
        const entry = get().entries.find(
          (entry) => entry.session.sessionId === sessionId,
        );
        if (!entry || entry.phase !== "question") return;
        if (entry.projectChangePending) return;
        if (
          !answer.trim() ||
          answer === "Skip this question (no option selected)."
        )
          throw new Error("Choose how to handle this draft before continuing.");
        const { session } = entry;
        if (
          useDocumentStore.getState().projectRoot !== session.projectRoot ||
          useAgentChatStore.getState().activeTabId !== session.tabId
        )
          throw new Error("Open this session before answering.");
        if (answer === "Check again") {
          await get().recheck(sessionId);
          return;
        }
        if (answer === "Keep safe changes only") {
          // Recompute rather than trusting the conflict list from when the question opened.
          const fresh = await previewAgentWorkspace(
            session.projectRoot,
            sessionId,
            previewDecisions(entry),
          );
          const safe = fresh.changes.filter(
            (change) =>
              !fresh.conflicts.some(
                (conflict) => conflict.changeId === change.id,
              ),
          );
          if (!safe.length)
            throw new Error(
              "No safe changes remain. Update or discard this draft.",
            );
          set((state) => ({
            entries: state.entries.map((item) =>
              item.session.sessionId === sessionId
                ? {
                    ...item,
                    preview: fresh,
                    excludedChangeIds: undefined,
                    editedContents: undefined,
                    conflicts: fresh.conflicts,
                    phase: "review",
                    error: undefined,
                  }
                : item,
            ),
          }));
          await get().show(sessionId);
          return;
        }
        if (answer === "Discard draft") {
          await retireAgentDraft(session);
          await get().finish(sessionId);
          return;
        }
        // Refinement always keeps the same proposal and worktree. Refresh the
        // review first so its source revision and conflict context are current.
        await get().recheck(sessionId);
        let refreshed = get().entries.find(
          (item) => item.session.sessionId === sessionId,
        );
        // Non-text and path conflicts still have a valid proposal, even though
        // the text resolver cannot display them. Explicit refinement can use
        // their paths/reasons and the existing worktree without discarding it.
        if (
          refreshed?.phase === "question" &&
          refreshed.preview &&
          refreshed.conflicts.length &&
          !refreshed.error
        ) {
          set((state) => ({
            entries: state.entries.map((item) =>
              item.session.sessionId === sessionId
                ? { ...item, phase: "review" }
                : item,
            ),
          }));
          await get().show(sessionId);
          refreshed = get().entries.find(
            (item) => item.session.sessionId === sessionId,
          );
        }
        if (refreshed?.phase !== "review")
          throw new Error(
            "The draft is preserved. Resolve the project error before refining.",
          );
        await useAgentChatStore
          .getState()
          .sendPrompt(
            answer === "Update draft"
              ? "Refine this pending proposal against the latest project. Preserve user edits and previously applied changes, and address the overlapping edits shown in review."
              : answer,
            undefined,
            false,
            undefined,
            session.tabId,
          );
      },
    }),
    {
      name: "catalex-agent-review-queue",
      ...workspaceStatePersistence,
      partialize: (state) => ({ entries: state.entries }),
    },
  ),
);

synchronizePersistedStore(useAgentReviewQueueStore);
