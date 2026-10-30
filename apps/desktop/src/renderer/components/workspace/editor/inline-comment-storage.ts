import { EditorState, Text } from "@codemirror/state";
import { clearCommentDocumentModels } from "./comment-document-model";
import { trackCommentSaving } from "./comment-save-state";
import {
  COMMENT_PATHS_CHANGED_EVENT,
  detachComments,
  isCommentDetached,
  clearCommentPaths,
  remapTrackedCommentPaths,
  resolveCommentPath,
  trackCommentPath,
  reconnectTrackedComments,
  type CommentPathChange,
} from "./comment-paths";
import { remapCommentDraftPaths } from "./comment-draft-history";
import { useDocumentStore } from "@/stores/document-store";
import { createDocumentChangeSet } from "./document-changes";
import {
  mapInlineCommentsThroughChanges,
  resetCommentPosition,
} from "./inline-comments";
import { toast } from "sonner";
import {
  clearProjectCommentDrafts,
  type CommentDraft,
} from "./comment-draft-history";
import { invoke } from "@/lib/desktop/core";
import {
  OPEN_COMMENT_MANAGER_EVENT,
  PROJECT_COMMENTS_REFRESH_EVENT,
} from "@/lib/workspace-events";
import type { InlineEditorComment } from "./inline-comments";

export type InlineCommentsByFile = Record<string, InlineEditorComment[]>;
export interface CommentPatch {
  draftOnly?: boolean;
  draft?: { before: CommentDraft | null; after: CommentDraft | null };
  filePath: string;
  id: string;
  before: InlineEditorComment | null;
  after: InlineEditorComment | null;
}
export interface CommentChangeEvent {
  projectRoot: string;
  tabId?: string;
  historyReplay?: boolean;
  patch: CommentPatch;
  patches?: CommentPatch[];
}

function stored(comment: InlineEditorComment): InlineEditorComment {
  return {
    id: comment.id,
    number: comment.number,
    anchorRevision: comment.anchorRevision,
    positionReset: comment.positionReset || undefined,
    removedAnchor: comment.removedAnchor,
    from: comment.from,
    to: comment.to,
    line: comment.line,
    text: comment.text,
    createdAt: comment.createdAt,
    origin: comment.origin,
    resolved: comment.resolved || undefined,
    proposal: comment.proposal,
  };
}
const equal = (a: unknown, b: unknown) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

export function commentPatches(
  before: InlineCommentsByFile,
  after: InlineCommentsByFile,
  contentOnly = false,
): CommentPatch[] {
  const changes: CommentPatch[] = [];
  for (const filePath of new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ])) {
    if (before[filePath] === after[filePath]) continue;
    const previous = new Map(
      (before[filePath] ?? [])
        .filter((c) => c.text.trim())
        .map((c) => [c.id, c]),
    );
    const next = new Map(
      (after[filePath] ?? [])
        .filter((c) => c.text.trim())
        .map((c) => [c.id, c]),
    );
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      const oldComment = previous.get(id);
      const newComment = next.get(id);
      if (oldComment === newComment) continue;
      // History tracks message/status actions, not per-keystroke anchor moves.
      // Check these cheap fields before allocating or serializing full records.
      if (
        contentOnly &&
        oldComment &&
        newComment &&
        oldComment.text === newComment.text &&
        Boolean(oldComment.resolved) === Boolean(newComment.resolved)
      )
        continue;
      const oldValue = oldComment ? stored(oldComment) : null;
      const newValue = newComment ? stored(newComment) : null;
      if (!equal(oldValue, newValue))
        changes.push({ filePath, id, before: oldValue, after: newValue });
    }
  }
  return changes;
}

// Merge notifications without overwriting a local edit that has not been saved.
export function applyCommentPatch(
  files: InlineCommentsByFile,
  patch: CommentPatch,
): InlineCommentsByFile {
  const comments = files[patch.filePath] ?? [];
  const current = comments.find((c) => c.id === patch.id);
  if (!current) {
    if (patch.before || !patch.after) return files;
    return { ...files, [patch.filePath]: [...comments, patch.after] };
  }
  if (!patch.after) {
    if (!patch.before || !equal(stored(current), stored(patch.before)))
      return files;
    return {
      ...files,
      [patch.filePath]: comments.filter((c) => c.id !== patch.id),
    };
  }
  if (!patch.before) {
    // First-save metadata belongs to the optimistic draft too. Keep newer local
    // text/ranges, but retain the persisted source revision for a later delete.
    if (current.number == null && patch.after.number != null) {
      return {
        ...files,
        [patch.filePath]: comments.map((comment) =>
          comment.id === patch.id
            ? {
                ...comment,
                number: patch.after!.number,
                anchorRevision:
                  comment.anchorRevision ??
                  (comment.from === patch.after!.from &&
                  comment.to === patch.after!.to &&
                  comment.line === patch.after!.line
                    ? patch.after!.anchorRevision
                    : undefined),
              }
            : comment,
        ),
      };
    }
    return files;
  }
  const merged = { ...current, proposal: patch.after.proposal };
  if (patch.after.number != null) merged.number = patch.after.number;
  if (
    current.from === patch.before.from &&
    current.to === patch.before.to &&
    current.line === patch.before.line
  ) {
    Object.assign(merged, {
      from: patch.after.from,
      to: patch.after.to,
      line: patch.after.line,
      anchorRevision: patch.after.anchorRevision,
      positionReset: patch.after.positionReset,
      removedAnchor: patch.after.removedAnchor,
    });
  }
  for (const key of ["text", "resolved"] as const) {
    if (
      key === "resolved"
        ? Boolean(current[key]) === Boolean(patch.before[key])
        : equal(current[key], patch.before[key])
    )
      Object.assign(merged, { [key]: patch.after[key] });
  }
  if (equal(merged, current)) return files;
  return {
    ...files,
    [patch.filePath]: comments.map((c) => (c.id === patch.id ? merged : c)),
  };
}

// Reuse the single-comment merge rules without rescanning the whole file for
// every acknowledgement or range update in a typing transaction.
export function applyCommentPatches(
  files: InlineCommentsByFile,
  patches: CommentPatch[],
): InlineCommentsByFile {
  const byPath = new Map<string, CommentPatch[]>();
  for (const patch of patches) {
    const group = byPath.get(patch.filePath) ?? [];
    group.push(patch);
    byPath.set(patch.filePath, group);
  }
  let result = files;
  for (const [path, group] of byPath) {
    const original = files[path] ?? [];
    const comments = new Map(original.map((comment) => [comment.id, comment]));
    let changed = false;
    for (const patch of group) {
      const current = comments.get(patch.id);
      const one = { [path]: current ? [current] : [] };
      const merged = applyCommentPatch(one, patch);
      if (merged === one) continue;
      changed = true;
      const next = merged[path]?.[0];
      if (next) comments.set(patch.id, next);
      else comments.delete(patch.id);
    }
    if (changed) result = { ...result, [path]: [...comments.values()] };
  }
  return result;
}

function commentContent(comment: InlineEditorComment) {
  const {
    from,
    to,
    line,
    anchorRevision,
    positionReset,
    removedAnchor,
    ...rest
  } = comment;
  return rest;
}
function anchorOnly(patch: CommentPatch) {
  return (
    !!patch.before &&
    !!patch.after &&
    equal(commentContent(patch.before), commentContent(patch.after))
  );
}

// Refreshes must not repair a snapshot superseded by local edits during I/O.
const commentSaveVersions = new Map<string, number>();
const snapshotRevisions = new Map<string, number>();
type ProjectCommentSnapshot = {
  files: InlineCommentsByFile;
  disconnected: InlineCommentsByFile;
  counters: number[];
};
// Share only outstanding reads. Settled results are released, and mutations or
// notifications prevent a later subscriber from joining an older read.
const snapshotReads = new Map<
  string,
  Map<boolean, Promise<ProjectCommentSnapshot>>
>();
export function invalidateProjectCommentSnapshot(projectRoot: string) {
  snapshotReads.delete(projectRoot);
  // Removing sharing alone cannot revoke a response already in flight. The
  // reader checks this revision before publishing paths/detachment or repairs.
  snapshotRevisions.set(
    projectRoot,
    (snapshotRevisions.get(projectRoot) ?? 0) + 1,
  );
}

export async function loadProjectInlineComments(
  projectRoot: string,
): Promise<InlineCommentsByFile> {
  return (await loadProjectCommentSnapshot(projectRoot)).files;
}

export function loadProjectCommentSnapshot(
  projectRoot: string,
  includeDisconnected = false,
): Promise<ProjectCommentSnapshot> {
  const reads = snapshotReads.get(projectRoot) ?? new Map();
  const existing = reads.get(includeDisconnected);
  if (existing) return existing;
  const operation = readProjectCommentSnapshot(
    projectRoot,
    includeDisconnected,
  ).finally(() => {
    if (reads.get(includeDisconnected) === operation)
      reads.delete(includeDisconnected);
    if (!reads.size && snapshotReads.get(projectRoot) === reads)
      snapshotReads.delete(projectRoot);
  });
  reads.set(includeDisconnected, operation);
  snapshotReads.set(projectRoot, reads);
  return operation;
}

async function readProjectCommentSnapshot(
  projectRoot: string,
  includeDisconnected: boolean,
): Promise<ProjectCommentSnapshot> {
  // A refresh must not read the disk before this renderer's queued saves land.
  if (pending.has(projectRoot) || unsaved.has(projectRoot))
    await flushProjectCommentWrites(projectRoot);
  const readRevision = snapshotRevisions.get(projectRoot) ?? 0;
  const saveVersion = commentSaveVersions.get(projectRoot);
  const snapshot = await invoke<{
    files: InlineCommentsByFile;
    sources: Record<string, string>;
    documents: Record<string, string>;
    pathChanges?: CommentPathChange[];
    orphanedPaths?: string[];
    orphanedIds?: string[];
    disconnected?: InlineCommentsByFile;
    counters: number[];
  }>("read_project_comments_anchored", {
    projectRoot,
    ...(includeDisconnected ? { includeDisconnected: true } : {}),
  });
  if (
    readRevision !== (snapshotRevisions.get(projectRoot) ?? 0) ||
    saveVersion !== commentSaveVersions.get(projectRoot)
  )
    return readProjectCommentSnapshot(projectRoot, includeDisconnected);
  toast.dismiss("comment-path-recovery");
  detachComments(projectRoot, snapshot?.orphanedIds ?? []);
  if (snapshot?.pathChanges?.length)
    publishCommentPathChanges(projectRoot, snapshot.pathChanges);
  if (snapshot?.orphanedPaths?.length)
    toast.error("Some comments are disconnected.", {
      id: "orphaned-project-comments",
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: "Manage",
        onClick: () =>
          window.dispatchEvent(
            new CustomEvent(OPEN_COMMENT_MANAGER_EVENT, {
              detail: { projectRoot },
            }),
          ),
      },
    });
  else toast.dismiss("orphaned-project-comments");
  const files = snapshot?.files ?? {};
  for (const [path, comments] of Object.entries(files))
    for (const comment of comments)
      reconnectTrackedComments(projectRoot, [comment.id], path);
  const disconnected = snapshot?.disconnected ?? {};
  const counters = snapshot?.counters ?? [0, 0];
  if (!Object.keys(files).length) return { files, disconnected, counters };
  const references = snapshot.sources ?? {};
  const repaired: InlineCommentsByFile = {};
  const sources: Record<string, string> = {};
  const buffers = new Map<string, string | undefined>();
  const localBuffer = (path: string) => {
    const state = useDocumentStore.getState();
    return state.projectRoot === projectRoot && !state.agentWorkspaceRoot
      ? state.files.find((file) => file.relativePath === path && file.isDirty)
          ?.content
      : undefined;
  };
  for (const [path, comments] of Object.entries(files)) {
    const buffer = localBuffer(path);
    buffers.set(path, buffer);
    // Only a known local buffer may advance beyond the native snapshot. A new
    // filesystem read here would bypass external replacement/disconnection rules.
    const documentRevision = snapshot.documents?.[path];
    const text = buffer ?? (documentRevision && references[documentRevision]);
    if (typeof text !== "string") {
      repaired[path] = comments;
      continue;
    }
    sources[path] = text;
    const revision =
      buffer != null ? await anchorRevision(text) : documentRevision!;
    let nextDoc: EditorState | undefined;
    const groups = new Map<string, InlineEditorComment[]>();
    for (const comment of comments) {
      const basis = comment.anchorRevision;
      if (!basis || basis === revision || references[basis] === undefined)
        continue;
      const group = groups.get(basis) ?? [];
      group.push(comment);
      groups.set(basis, group);
    }
    const mapped = new Map<string, InlineEditorComment>();
    for (const [basis, group] of groups) {
      const previous = references[basis];
      try {
        // Apply a source revision once for all of its comments. Replaying the
        // full text operation separately per anchor scales with file size ×
        // comment count, even when the diff itself is cached.
        const result = mapInlineCommentsThroughChanges(
          group,
          createDocumentChangeSet(previous, text, "\n"),
          (nextDoc ??= EditorState.create({ doc: Text.of(text.split("\n")) })),
          EditorState.create({ doc: Text.of(previous.split("\n")) }),
        );
        for (const comment of result) mapped.set(comment.id, comment);
      } catch {
        for (const comment of group)
          mapped.set(comment.id, resetCommentPosition(comment, text));
      }
    }
    repaired[path] = comments.map((comment) => {
      if (comment.anchorRevision === revision) {
        return Number.isInteger(comment.from) &&
          Number.isInteger(comment.to) &&
          comment.from >= 0 &&
          comment.to >= comment.from &&
          comment.to <= text.length
          ? comment
          : resetCommentPosition(comment, text);
      }
      let next = comment;
      const previous = comment.anchorRevision
        ? references[comment.anchorRevision]
        : undefined;
      if (previous !== undefined) {
        next = mapped.get(comment.id) ?? resetCommentPosition(comment, text);
      } else if (
        comment.anchorRevision ||
        !Number.isInteger(comment.from) ||
        !Number.isInteger(comment.to) ||
        comment.from < 0 ||
        comment.to < comment.from ||
        comment.to > text.length
      ) {
        next = resetCommentPosition(comment, text);
      }
      return { ...next, anchorRevision: revision };
    });
  }
  // Hashing dirty buffers yields. An editor save may have
  // advanced the anchors while we were repairing this older snapshot.
  if (
    readRevision !== (snapshotRevisions.get(projectRoot) ?? 0) ||
    saveVersion !== commentSaveVersions.get(projectRoot) ||
    [...buffers].some(([path, text]) => localBuffer(path) !== text)
  )
    return readProjectCommentSnapshot(projectRoot, includeDisconnected);
  try {
    if (!restoring.has(projectRoot))
      await saveProjectInlineComments(projectRoot, files, repaired, sources);
  } catch {
    toast.error(
      "Document editing remains available. Comment positions could not be saved; recovery will retry when the project opens.",
      { id: "comment-anchor-recovery" },
    );
  }
  for (const comment of Object.values(repaired).flat())
    rememberComment(projectRoot, comment);
  return { files: repaired, disconnected, counters };
}

const pending = new Map<string, Promise<void>>();
// Failed optimistic edits remain in order until retried successfully. A later
// edit must not make an earlier failure invisible to the project-exit boundary.
type CommentSaveJob = (() => Promise<void>) & {
  paths: () => string[];
  setSaving?: (saving: boolean) => void;
  conflict?: () => CommentPatch | undefined;
  resolve?: (id: string, current: CommentPatch, keep: boolean) => CommentPatch;
  deletes?: (id: string) => boolean;
  acknowledge?: (
    requested: InlineEditorComment,
    saved: InlineEditorComment,
  ) => void;
  merge?: (
    patches: CommentPatch[],
    sources: Record<string, string>,
    versions: number[],
    barrier: number,
  ) => boolean;
};
export const COMMENT_CONFLICT_RESOLVED_EVENT =
  "catalex:comment-conflict-resolved";

// Change only fields the user actually edited; retain independent remote edits.
function rebaseComment(
  patch: CommentPatch,
  current: CommentPatch,
): CommentPatch {
  let after = patch.after;
  if (after && current.after) {
    after = { ...current.after };
    for (const key of ["text", "resolved"] as const) {
      if (!patch.before || !equal(patch.before[key], patch.after![key]))
        Object.assign(after, { [key]: patch.after![key] });
    }
    if (
      !patch.before ||
      ["from", "to", "line", "positionReset", "removedAnchor"].some(
        (key) =>
          !equal(
            patch.before![key as keyof InlineEditorComment],
            patch.after![key as keyof InlineEditorComment],
          ),
      )
    ) {
      for (const key of [
        "from",
        "to",
        "line",
        "anchorRevision",
        "positionReset",
        "removedAnchor",
      ] as const)
        Object.assign(after, { [key]: patch.after![key] });
    }
  } else if (after) {
    after = { ...after, number: undefined };
  }
  return { ...patch, filePath: current.filePath, before: current.after, after };
}

export function showCommentSaveError(
  root: string,
  error: unknown,
  retry: () => void,
) {
  const conflict = (unsaved.get(root) ?? [])
    .find((job) => job.conflict?.())
    ?.conflict?.();
  const resolve = (keep: boolean) => {
    void resolveCommentSaveConflict(root, keep, conflict?.id)
      .then(() => {
        toast.dismiss(`comment-save:${root}`);
      })
      .catch((failure) => showCommentSaveError(root, failure, retry));
  };
  toast.error(
    conflict
      ? "Comment changed elsewhere."
      : `Comment changes were not saved: ${String(error)}. Your changes are kept for retry.`,
    {
      id: `comment-save:${root}`,
      duration: Number.POSITIVE_INFINITY,
      description: conflict
        ? String(error).includes("comment_conflict:") ||
          String(error).includes("comment_orphaned:")
          ? conflict.filePath
          : `${conflict.filePath}: ${String(error).replace(/^Error: /, "")}`
        : undefined,
      action: conflict
        ? { label: "Keep mine", onClick: () => resolve(true) }
        : { label: "Retry saving", onClick: retry },
      cancel: conflict
        ? { label: "Use stored", onClick: () => resolve(false) }
        : undefined,
    },
  );
}

export async function resolveCommentSaveConflict(
  root: string,
  keep: boolean,
  expectedId?: string,
) {
  breakSaveGroup(root);
  const operation = (pending.get(root) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const jobs = unsaved.get(root) ?? [];
      const conflict = jobs.find((job) => job.conflict?.())?.conflict?.();
      if (!conflict) return;
      if (expectedId && conflict.id !== expectedId)
        throw new Error(
          "The pending conflict changed. Review the current choice before continuing.",
        );
      // Deliberately bypass the renderer's flush-before-read: that queue is blocked
      // by the conflict we are resolving. The native read retains path recovery.
      const snapshot = await invoke<{
        files: InlineCommentsByFile;
        orphanedIds?: string[];
      }>("read_project_comments_anchored", { projectRoot: root });
      if (keep && snapshot.orphanedIds?.includes(conflict.id))
        throw new Error(
          "This comment is disconnected. Use stored, then relink it in the comment manager.",
        );
      const location = Object.entries(snapshot.files).find(([, comments]) =>
        comments.some((c) => c.id === conflict.id),
      );
      const saved = location?.[1].find((c) => c.id === conflict.id) ?? null;
      if (keep && !saved && (conflict.after ?? conflict.before)?.origin)
        throw new Error(
          "This agent comment was removed. Use stored to accept its removal.",
        );
      if (location) reconnectTrackedComments(root, [conflict.id], location[0]);
      let change: CommentPatch = {
        ...conflict,
        filePath: location?.[0] ?? conflict.filePath,
        before: null,
        after: saved,
      };
      // Include edits queued while reading; resolving one comment never drops
      // unrelated writes. Each following intent is rebased in its original order.
      for (const job of jobs)
        change = job.resolve?.(conflict.id, change, keep) ?? change;
      window.dispatchEvent(
        new CustomEvent(COMMENT_CONFLICT_RESOLVED_EVENT, {
          detail: { projectRoot: root, patch: change },
        }),
      );
      notifyCommentSaveProgress(root);
    });
  pending.set(root, operation);
  try {
    await operation;
  } finally {
    if (pending.get(root) === operation) pending.delete(root);
  }
  await flushProjectCommentWrites(root);
  window.dispatchEvent(
    new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
      detail: { projectRoot: root },
    }),
  );
}

const saveBarriers = new Map<string, number>();
function breakSaveGroup(root: string) {
  saveBarriers.set(root, (saveBarriers.get(root) ?? 0) + 1);
}
const unsaved = new Map<string, CommentSaveJob[]>();
export function isCommentPendingDeletion(root: string, id: string) {
  return (unsaved.get(root) ?? []).some((job) => job.deletes?.(id));
}
function sameCommentValue(a: InlineEditorComment, b: InlineEditorComment) {
  return equal(
    stored({ ...a, number: undefined, anchorRevision: undefined }),
    stored({ ...b, number: undefined, anchorRevision: undefined }),
  );
}
function acknowledgeCommentSave(
  root: string,
  requested: InlineEditorComment | null,
  saved: InlineEditorComment | null | undefined,
) {
  // Only carry server-owned metadata from our own successful write. Never
  // adopt concurrently changed content as permission for a queued deletion.
  if (!requested || !saved || !sameCommentValue(requested, saved)) return;
  for (const job of unsaved.get(root) ?? [])
    job.acknowledge?.(requested, saved);
}

export const COMMENT_SAVE_PROGRESS_EVENT = "catalex:comment-save-progress";
export function getUnsavedCommentFiles(root: string): string[] {
  return [
    ...new Set((unsaved.get(root) ?? []).flatMap((job) => job.paths())),
  ].sort();
}
function notifyCommentSaveProgress(root: string) {
  window.dispatchEvent(
    new CustomEvent(COMMENT_SAVE_PROGRESS_EVENT, { detail: root }),
  );
}
function drainCommentSaves(root: string): Promise<void> {
  // Respect path/history operations already inserted between save batches.
  const jobsAtSchedule = unsaved.get(root);
  const through = jobsAtSchedule?.[jobsAtSchedule.length - 1];
  const operation = (pending.get(root) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const jobs = unsaved.get(root);
      while (jobs?.length) {
        const job = jobs[0];
        job.setSaving?.(true);
        try {
          await job();
        } catch (error) {
          // A failure blocks later jobs too. Stop their spinners and enable
          // controls, but retain every intent for the existing retry flow.
          for (const queued of jobs) queued.setSaving?.(false);
          throw error;
        }
        job.setSaving?.(false);
        jobs.shift();
        notifyCommentSaveProgress(root);
        if (job === through) break;
      }
      if (!jobs?.length) unsaved.delete(root);
    });
  pending.set(root, operation);
  void operation
    .finally(() => {
      if (pending.get(root) === operation) pending.delete(root);
    })
    .catch(() => {});
  return operation;
}
const restoring = new Set<string>();
export const COMMENTS_RESTORED_EVENT = "catalex:comments-restored";
export async function flushProjectCommentWrites(root: string) {
  breakSaveGroup(root);
  while (pending.has(root) || unsaved.has(root)) {
    const saving = pending.get(root);
    if (saving) await saving;
    else await drainCommentSaves(root);
  }
}
export function notifyProjectCommentsRestored(root: string) {
  invalidateProjectCommentSnapshot(root);
  clearCommentDocumentModels();
  // Rewind replaces the timeline, including whole-group clears and drafts.
  for (const agent of [false, true]) {
    const key = groupKey(root, agent);
    generations.set(key, (generations.get(key) ?? 0) + 1);
    clearProjectCommentDrafts(root, agent);
  }
  clearCommentPaths(root);
  knownComments.delete(root);
  clearedComments.delete(root);
  window.dispatchEvent(
    new CustomEvent(COMMENTS_RESTORED_EVENT, { detail: { projectRoot: root } }),
  );
}
export async function restoreWithProjectComments<T>(
  root: string,
  restore: () => Promise<T>,
): Promise<T> {
  if (restoring.has(root))
    throw new Error("History is already being restored.");
  restoring.add(root);
  invalidateProjectCommentSnapshot(root);
  let completed = false;
  try {
    await flushProjectCommentWrites(root);
    const result = await restore();
    completed = true;
    return result;
  } finally {
    restoring.delete(root);
    // A rejected save/restore must retain unsaved comment drafts and undo.
    if (completed) notifyProjectCommentsRestored(root);
    else invalidateProjectCommentSnapshot(root);
  }
}
const clearing = new Set<string>();
const generations = new Map<string, number>();
const knownComments = new Map<string, Map<string, boolean>>();
const clearedComments = new Map<string, Set<string>>();
export const COMMENTS_CLEARED_EVENT = "catalex:comments-cleared";
const groupKey = (root: string, agent: boolean) =>
  JSON.stringify([root, agent]);
export function rememberComment(root: string, comment: InlineEditorComment) {
  const known = knownComments.get(root) ?? new Map<string, boolean>();
  known.set(comment.id, Boolean(comment.origin));
  knownComments.set(root, known);
}
export function wasCommentCleared(root: string, id: string) {
  return clearedComments.get(root)?.has(id) ?? false;
}
export function notifyCommentsCleared(root: string, agent: boolean) {
  invalidateProjectCommentSnapshot(root);
  const key = groupKey(root, agent);
  generations.set(key, (generations.get(key) ?? 0) + 1);
  const removed = clearedComments.get(root) ?? new Set<string>();
  for (const [id, kind] of knownComments.get(root) ?? [])
    if (kind === agent) removed.add(id);
  clearedComments.set(root, removed);
  clearProjectCommentDrafts(root, agent);
  window.dispatchEvent(
    new CustomEvent(COMMENTS_CLEARED_EVENT, {
      detail: { projectRoot: root, agent },
    }),
  );
}
export async function clearProjectComments(
  projectRoot: string,
  agent: boolean,
) {
  if (restoring.has(projectRoot))
    throw new Error("History is being restored. Try again when it finishes.");
  const key = groupKey(projectRoot, agent);
  if (clearing.has(key)) return;
  clearing.add(key);
  breakSaveGroup(projectRoot);
  const operation = (pending.get(projectRoot) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await invoke("clear_project_comments", { projectRoot, agent });
      notifyCommentsCleared(projectRoot, agent);
    });
  pending.set(projectRoot, operation);
  try {
    await operation;
  } finally {
    clearing.delete(key);
    if (pending.get(projectRoot) === operation) pending.delete(projectRoot);
  }
}
export function saveProjectInlineComments(
  projectRoot: string,
  before: InlineCommentsByFile,
  after: InlineCommentsByFile,
  sourceOverrides?: Record<string, string>,
): Promise<void> {
  if (restoring.has(projectRoot)) {
    // Source refreshes can emit automatic anchor-only updates. The restored
    // snapshot owns these positions; reload them after the rewind completes.
    if (!commentHistoryPatches(before, after).length) return Promise.resolve();
    return Promise.reject(
      new Error(
        "History is being restored. Try editing comments again when it finishes.",
      ),
    );
  }
  const patches = commentPatches(before, after).filter((patch) => {
    const comment = patch.after ?? patch.before!;
    rememberComment(projectRoot, comment);
    trackCommentPath(projectRoot, comment.id, patch.filePath);
    return (
      !clearing.has(groupKey(projectRoot, Boolean(comment.origin))) &&
      !wasCommentCleared(projectRoot, patch.id)
    );
  });
  const versions = patches.map(
    (patch) =>
      generations.get(
        groupKey(projectRoot, Boolean((patch.after ?? patch.before)?.origin)),
      ) ?? 0,
  );
  if (!patches.length) return Promise.resolve();
  invalidateProjectCommentSnapshot(projectRoot);
  commentSaveVersions.set(
    projectRoot,
    (commentSaveVersions.get(projectRoot) ?? 0) + 1,
  );
  // Capture the editor version now, before this operation waits behind other saves.
  const state = useDocumentStore.getState();
  const sources = { ...sourceOverrides };
  const changedPaths = new Set(patches.map((patch) => patch.filePath));
  if (state.projectRoot === projectRoot && !state.agentWorkspaceRoot)
    for (const file of state.files)
      if (
        changedPaths.has(file.relativePath) &&
        file.content !== undefined &&
        sources[file.relativePath] === undefined
      )
        sources[file.relativePath] = file.content;
  const barrier = saveBarriers.get(projectRoot) ?? 0;
  const queued = unsaved.get(projectRoot);
  const tail = queued?.[queued.length - 1];
  if (tail?.merge?.(patches, sources, versions, barrier))
    return drainCommentSaves(projectRoot);
  let started = false;
  let conflict: CommentPatch | undefined;
  let batchConflict = false;
  const sourceFree = new Set<number>();
  const remaining = new Set(patches.map((_, index) => index));
  const savingStates = new Map(
    patches.flatMap((patch, index) =>
      anchorOnly(patch)
        ? []
        : [[index, trackCommentSaving(projectRoot, patch.id)] as const],
    ),
  );
  const setSaving = (saving: boolean) => {
    for (const [index, set] of savingStates)
      set(saving && remaining.has(index));
  };
  const complete = (index: number) => {
    remaining.delete(index);
    savingStates.get(index)?.(false);
  };
  const indicesById = new Map<string, number[]>();
  patches.forEach((patch, index) => {
    const indices = indicesById.get(patch.id) ?? [];
    indices.push(index);
    indicesById.set(patch.id, indices);
  });
  const write = async () => {
    started = true;
    const anchorGroups = new Map<string, number[]>();
    for (const index of remaining) {
      const patch = patches[index];
      if (
        (generations.get(groupKey(projectRoot, Boolean(patch.after?.origin))) ??
          0) !== versions[index]
      )
        continue;
      if (
        batchConflict ||
        sourceFree.has(index) ||
        sources[patch.filePath] === undefined ||
        !anchorOnly(patch)
      )
        continue;
      const group = anchorGroups.get(patch.filePath) ?? [];
      group.push(index);
      anchorGroups.set(patch.filePath, group);
    }
    for (const [path, indices] of anchorGroups) {
      if (indices.length < 2) continue;
      const revision = await anchorRevision(sources[path]);
      let result: { orphanedIds: string[] };
      try {
        result = await invoke<{ orphanedIds: string[] }>(
          "update_project_comment_anchors",
          {
            projectRoot,
            source: sources[path],
            patches: indices.map((index) => {
              const patch = patches[index];
              return {
                ...patch,
                filePath: resolveCommentPath(
                  projectRoot,
                  patch.id,
                  patch.filePath,
                ),
                after: { ...patch.after!, anchorRevision: revision },
              };
            }),
          },
        );
      } catch (error) {
        if (
          !String(error).includes("comment_conflict:") &&
          !String(error).includes("comment_anchor_superseded:")
        )
          throw error;
        // The native batch is atomic. Retry individually to identify the exact
        // conflicting comment and let the user resolve only that record.
        batchConflict = true;
        continue;
      }
      for (const index of indices) {
        const patch = patches[index];
        if (!result.orphanedIds.includes(patch.id))
          acknowledgeCommentSave(projectRoot, patch.after, {
            ...patch.after!,
            anchorRevision: revision,
          });
        complete(index);
      }
      notifyCommentSaveProgress(projectRoot);
      if (result.orphanedIds.length)
        window.dispatchEvent(
          new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
            detail: { projectRoot },
          }),
        );
    }
    for (const [index, patch] of patches.entries()) {
      if (!remaining.has(index)) continue;
      if (
        (generations.get(
          groupKey(projectRoot, Boolean((patch.after ?? patch.before)?.origin)),
        ) ?? 0) !== versions[index]
      ) {
        complete(index);
        notifyCommentSaveProgress(projectRoot);
        continue;
      }
      const source = sourceFree.has(index)
        ? undefined
        : sources[patch.filePath];
      patch.filePath = resolveCommentPath(
        projectRoot,
        patch.id,
        patch.filePath,
      );
      try {
        if (source !== undefined && patch.after) {
          const after = {
            ...patch.after,
            anchorRevision: await anchorRevision(source),
          };
          const change = await invoke<CommentPatch>(
            "update_project_comment_anchored",
            {
              projectRoot,
              patch: { ...patch, after },
              source,
            },
          );
          acknowledgeCommentSave(projectRoot, patch.after, change?.after);
        } else {
          const change = await invoke<CommentPatch>("update_project_comment", {
            projectRoot,
            patch,
          });
          acknowledgeCommentSave(projectRoot, patch.after, change?.after);
        }
      } catch (error) {
        if (
          anchorOnly(patch) &&
          String(error).includes("comment_anchor_superseded:")
        ) {
          // Native recovery already placed (or lost) this anchor on the same
          // source. An older queued mapping must not overwrite it or block saves.
          complete(index);
          window.dispatchEvent(
            new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
              detail: { projectRoot },
            }),
          );
          continue;
        }
        if (
          String(error).includes("comment_conflict:") ||
          (String(error).includes("comment_orphaned:") && !anchorOnly(patch))
        )
          conflict = patch;
        // External recovery may disconnect a comment before its queued editor
        // position update arrives. The saved orphan already owns its original
        // anchor; do not let that obsolete update block all later saves.
        if (
          !String(error).includes("comment_orphaned:") ||
          !patch.before ||
          !patch.after ||
          !anchorOnly(patch)
        )
          throw error;
        window.dispatchEvent(
          new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
            detail: { projectRoot },
          }),
        );
      }
      complete(index);
      notifyCommentSaveProgress(projectRoot);
    }
  };
  const jobs = unsaved.get(projectRoot) ?? [];
  jobs.push(
    Object.assign(write, {
      setSaving,
      conflict: () => conflict,
      resolve: (id: string, current: CommentPatch, keep: boolean) => {
        for (const index of indicesById.get(id) ?? []) {
          if (!remaining.has(index)) continue;
          if (keep) {
            const original = patches[index];
            const rebased = rebaseComment(original, current);
            if (sources[original.filePath] !== undefined)
              sources[rebased.filePath] = sources[original.filePath];
            // A content-only resolution must not attach remote coordinates to
            // an older editor source snapshot.
            if (
              original.before &&
              original.after &&
              original.before.from === original.after.from &&
              original.before.to === original.after.to &&
              original.before.line === original.after.line
            )
              sourceFree.add(index);
            patches[index] = rebased;
            current = rebased;
          } else complete(index);
        }
        if (conflict?.id === id) conflict = undefined;
        return current;
      },
      deletes: (id: string) =>
        (indicesById.get(id) ?? []).some(
          (index) => remaining.has(index) && !patches[index].after,
        ),
      acknowledge: (
        requested: InlineEditorComment,
        saved: InlineEditorComment,
      ) => {
        if (started) return;
        for (const index of indicesById.get(requested.id) ?? []) {
          if (!remaining.has(index)) continue;
          const patch = patches[index];
          if (
            !patch.before ||
            patch.id !== requested.id ||
            !sameCommentValue(patch.before, requested)
          )
            continue;
          patch.before = {
            ...patch.before,
            number: saved.number,
            anchorRevision: saved.anchorRevision,
          };
          if (patch.after)
            patch.after = {
              ...patch.after,
              number: saved.number,
              anchorRevision: saved.anchorRevision,
            };
        }
      },
      merge: (
        next: CommentPatch[],
        nextSources: Record<string, string>,
        nextVersions: number[],
        nextBarrier: number,
      ) => {
        // Only untouched, adjacent typing jobs with the same comments can merge.
        // Once attempted, failures retain their original payload for safe retry.
        if (
          started ||
          nextBarrier !== barrier ||
          next.length !== patches.length
        )
          return false;
        const path = patches[0].filePath;
        if (sources[path] === undefined || nextSources[path] === undefined)
          return false;
        if (
          !patches.every(
            (patch, index) =>
              patch.filePath === path &&
              anchorOnly(patch) &&
              next[index]?.filePath === path &&
              next[index].id === patch.id &&
              anchorOnly(next[index]) &&
              versions[index] === nextVersions[index] &&
              equal(patch.after, next[index].before),
          )
        )
          return false;
        for (let index = 0; index < patches.length; index++)
          patches[index].after = next[index].after;
        sources[path] = nextSources[path];
        return true;
      },
      paths: () =>
        [...remaining].map((index) => {
          const patch = patches[index];
          return resolveCommentPath(projectRoot, patch.id, patch.filePath);
        }),
    }),
  );
  unsaved.set(projectRoot, jobs);
  setSaving(true);
  notifyCommentSaveProgress(projectRoot);
  return drainCommentSaves(projectRoot);
}

// Record content actions, not anchor mapping, edit-mode toggles or number acknowledgements.
export function commentHistoryPatches(
  before: InlineCommentsByFile,
  after: InlineCommentsByFile,
) {
  return commentPatches(before, after, true);
}
export function warnSkippedCommentReplay(projectRoot: string, changed = false) {
  toast.warning(
    changed
      ? "Undo/redo skipped an outdated comment change."
      : "Undo/redo skipped a disconnected comment.",
    {
      id: `comment-replay-disconnected:${projectRoot}`,
      action: {
        label: "Manage",
        onClick: () =>
          window.dispatchEvent(
            new CustomEvent(OPEN_COMMENT_MANAGER_EVENT, {
              detail: { projectRoot },
            }),
          ),
      },
    },
  );
}

export function replayProjectComment(
  projectRoot: string,
  patch: CommentPatch,
  applied?: (change: CommentPatch) => void,
): Promise<CommentPatch | null> {
  invalidateProjectCommentSnapshot(projectRoot);
  if (restoring.has(projectRoot))
    return Promise.reject(
      new Error("History is being restored. Try again when it finishes."),
    );
  const agent = Boolean(
    (
      patch.after ??
      patch.before ??
      patch.draft?.after?.comment ??
      patch.draft?.before?.comment
    )?.origin,
  );
  const version = generations.get(groupKey(projectRoot, agent)) ?? 0;
  let result: CommentPatch | null = null;
  let discarded = false;
  const write = async () => {
    if (discarded) return;
    // Re-check at execution time: saves, clearing, and reconnecting can happen
    // while this replay waits in the shared queue.
    if (
      wasCommentCleared(projectRoot, patch.id) ||
      (generations.get(groupKey(projectRoot, agent)) ?? 0) !== version
    )
      return;
    if (isCommentDetached(projectRoot, patch.id)) {
      warnSkippedCommentReplay(projectRoot);
      return;
    }
    if (patch.draftOnly) {
      result = patch;
      applied?.(patch);
      return;
    }
    try {
      result = await invoke<CommentPatch>("replay_project_comment", {
        projectRoot,
        patch: {
          filePath: resolveCommentPath(projectRoot, patch.id, patch.filePath),
          id: patch.id,
          before: patch.before ? stored(patch.before) : null,
          after: patch.after ? stored(patch.after) : null,
        },
      });
    } catch (error) {
      // The backend may discover replacement before the renderer refreshes.
      if (String(error).includes("comment_orphaned:")) {
        warnSkippedCommentReplay(projectRoot);
        return;
      }
      if (String(error).includes("comment_conflict:")) {
        // A stale inverse cannot become valid by retrying the same disk write.
        warnSkippedCommentReplay(projectRoot, true);
        return;
      }
      throw error;
    }
    // History inverses share these values; retain assigned numbers for redo.
    if (patch.before && result.before)
      Object.assign(patch.before, result.before);
    if (patch.after && result.after) Object.assign(patch.after, result.after);
    applied?.(result);
  };
  const jobs = unsaved.get(projectRoot) ?? [];
  jobs.push(
    Object.assign(write, {
      resolve: (id: string, current: CommentPatch, keep: boolean) => {
        if (patch.id === id && !keep) discarded = true;
        return current;
      },
      paths: () => [resolveCommentPath(projectRoot, patch.id, patch.filePath)],
    }),
  );
  unsaved.set(projectRoot, jobs);
  notifyCommentSaveProgress(projectRoot);
  return drainCommentSaves(projectRoot).then(() => result);
}

async function anchorRevision(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Capture references before applying a draft; repair all affected files afterwards. */
export async function synchronizeProjectCommentAnchors(
  projectRoot: string,
): Promise<void> {
  await loadProjectInlineComments(projectRoot);
  window.dispatchEvent(
    new CustomEvent("catalex:project-comments-refresh", {
      detail: { projectRoot },
    }),
  );
}

export function receiveCommentsCleared(projectRoot: string, agent: boolean) {
  if (!clearing.has(groupKey(projectRoot, agent)))
    notifyCommentsCleared(projectRoot, agent);
}

export function publishCommentPathChanges(
  projectRoot: string,
  changes: CommentPathChange[],
) {
  if (!changes.length) return;
  invalidateProjectCommentSnapshot(projectRoot);
  remapTrackedCommentPaths(projectRoot, changes);
  remapCommentDraftPaths(projectRoot, changes);
  window.dispatchEvent(
    new CustomEvent(COMMENT_PATHS_CHANGED_EVENT, {
      detail: { projectRoot, changes },
    }),
  );
}

/** Queue path changes between comment writes; edits arriving during I/O follow
 * the same comment IDs to the new paths after publication. */
export function withCommentPathMutation<
  T extends {
    pathChanges?: CommentPathChange[];
    commentWarning?: string | null;
  },
>(projectRoot: string, mutate: () => Promise<T>): Promise<T> {
  invalidateProjectCommentSnapshot(projectRoot);
  breakSaveGroup(projectRoot);
  const operation = (pending.get(projectRoot) ?? Promise.resolve())
    .then(mutate)
    .then((result) => {
      publishCommentPathChanges(projectRoot, result.pathChanges ?? []);
      if (result.commentWarning)
        toast.error(
          `File changes completed. Comment recovery will retry: ${result.commentWarning}`,
          { id: "comment-path-recovery", duration: Number.POSITIVE_INFINITY },
        );
      return result;
    });
  const completion = operation.then(() => {});
  pending.set(projectRoot, completion);
  void completion
    .finally(() => {
      if (pending.get(projectRoot) === completion) pending.delete(projectRoot);
    })
    .catch(() => {});
  return operation;
}
