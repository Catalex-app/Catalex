import {
  COMMENT_PATHS_CHANGED_EVENT,
  isCommentDetached,
  remapCommentFiles,
  resolveCommentPath,
  reconnectTrackedComments,
  type CommentPathChange,
} from "./comment-paths";
import { COMMENTS_RESTORED_EVENT } from "./inline-comment-storage";
import { PROJECT_COMMENTS_REFRESH_EVENT } from "@/lib/workspace-events";
import {
  COMMENT_DRAFT_EVENT,
  COMMENT_HISTORY_EVENT,
  getCommentDraft,
  setCommentDraft,
  projectCommentDrafts,
  breakCommentTypingGroup,
} from "./comment-draft-history";
import { listen } from "@/lib/desktop/event";
import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import {
  COMMENTS_CLEARED_EVENT,
  COMMENT_CONFLICT_RESOLVED_EVENT,
  showCommentSaveError,
  rememberComment,
  wasCommentCleared,
  applyCommentPatch,
  applyCommentPatches,
  commentPatches,
  commentHistoryPatches,
  replayProjectComment,
  warnSkippedCommentReplay,
  loadProjectCommentSnapshot,
  invalidateProjectCommentSnapshot,
  saveProjectInlineComments,
  flushProjectCommentWrites,
  getUnsavedCommentFiles,
  type CommentChangeEvent,
  isCommentPendingDeletion,
  type CommentPatch,
  type InlineCommentsByFile,
} from "./inline-comment-storage";

// Local edits alone produce writes. Notifications update the same synchronous
// snapshot, so React batching can never turn an incoming addition into a delete.
export function useProjectComments(
  projectRoot: string | null,
  onChange?: (patch: CommentPatch) => void,
  includeDisconnected = false,
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [files, setFiles] = useState<InlineCommentsByFile>({});
  const [disconnected, setDisconnected] = useState<InlineCommentsByFile>({});
  const [reload, setReload] = useState(0);
  const [draftRevision, refreshDrafts] = useState(0);
  useEffect(() => {
    const stop = listen<{ projectRoot: string }>(
      "catalex-comment-checkpoint-failed",
      ({ payload }) => {
        if (payload.projectRoot === projectRoot)
          toast.warning(
            "Comment saved, but its history checkpoint could not be saved.",
            { id: `comment-checkpoint:${projectRoot}` },
          );
      },
    );
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, [projectRoot]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const { scope, id, draft } = (event as CustomEvent).detail;
      const snapshot = current.current;
      if (snapshot && snapshot.root === scope.root && !draft) {
        const before = snapshot.files;
        snapshot.files = previewNumbers(
          {
            ...snapshot.files,
            [scope.filePath]: (snapshot.files[scope.filePath] ?? []).flatMap(
              (c) => {
                if (c.id !== id) return [c];
                // New drafts can also live in the originating PDF pane's snapshot.
                // Closing the shared draft must remove that empty local copy too.
                return c.text.trim() ? [{ ...c, isEditing: false }] : [];
              },
            ),
          },
          snapshot.counters,
          before,
        );
        setFiles(snapshot.files);
      }
      refreshDrafts((n) => n + 1);
    };
    window.addEventListener(COMMENT_DRAFT_EVENT, refresh);
    return () => window.removeEventListener(COMMENT_DRAFT_EVENT, refresh);
  }, []);
  const [loadedRoot, setLoadedRoot] = useState<string | null>(null);
  const current = useRef<{
    root: string;
    files: InlineCommentsByFile;
    blocked: boolean;
    counters: number[];
  } | null>(null);

  const refreshComments = useCallback(() => {
    if (!projectRoot) return;
    invalidateProjectCommentSnapshot(projectRoot);
    const snapshot = current.current;
    // Empty local drafts have not necessarily entered the shared typing store.
    if (snapshot?.root === projectRoot)
      for (const [filePath, comments] of Object.entries(snapshot.files))
        for (const comment of comments) {
          const scope = { root: projectRoot, filePath };
          if (comment.isEditing && !getCommentDraft(scope, comment.id))
            setCommentDraft(scope, comment.id, {
              comment,
              text: comment.draftText ?? comment.text,
            });
        }
    setReload((value) => value + 1);
  }, [projectRoot]);

  useEffect(() => {
    const resolved = (event: Event) => {
      const { projectRoot: root, patch } = (
        event as CustomEvent<CommentChangeEvent>
      ).detail;
      const snapshot = current.current;
      if (!snapshot || snapshot.root !== root) return;
      const files = Object.fromEntries(
        Object.entries(snapshot.files).map(([path, comments]) => [
          path,
          comments.filter((c) => c.id !== patch.id),
        ]),
      );
      if (patch.after)
        files[patch.filePath] = [...(files[patch.filePath] ?? []), patch.after];
      snapshot.files = previewNumbers(files, snapshot.counters, snapshot.files);
      snapshot.blocked = false;
      setFiles(snapshot.files);
    };
    window.addEventListener(COMMENT_CONFLICT_RESOLVED_EVENT, resolved);
    return () =>
      window.removeEventListener(COMMENT_CONFLICT_RESOLVED_EVENT, resolved);
  }, []);

  useEffect(() => {
    const moved = (event: Event) => {
      const { projectRoot: root, changes } = (
        event as CustomEvent<{
          projectRoot: string;
          changes: CommentPathChange[];
        }>
      ).detail;
      const snapshot = current.current;
      if (!snapshot || snapshot.root !== root) return;
      invalidateProjectCommentSnapshot(root);
      snapshot.files = remapCommentFiles(snapshot.files, changes);
      setFiles(snapshot.files);
      refreshDrafts((n) => n + 1);
      setReload((n) => n + 1);
    };
    window.addEventListener(COMMENT_PATHS_CHANGED_EVENT, moved);
    return () => window.removeEventListener(COMMENT_PATHS_CHANGED_EVENT, moved);
  }, []);

  useEffect(() => {
    if (!projectRoot) return;
    const stop = listen<{ projectRoot: string }>(
      "catalex-comments-reconnected",
      ({ payload }) => {
        if (payload.projectRoot === projectRoot) {
          refreshComments();
        }
      },
    );
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, [projectRoot, refreshComments]);

  useEffect(() => {
    const restored = (event: Event) => {
      if (
        (event as CustomEvent<{ projectRoot: string }>).detail.projectRoot !==
        projectRoot
      )
        return;
      current.current = null;
      if (projectRoot) invalidateProjectCommentSnapshot(projectRoot);
      setFiles({});
      setReload((value) => value + 1);
    };
    window.addEventListener(COMMENTS_RESTORED_EVENT, restored);
    return () => window.removeEventListener(COMMENTS_RESTORED_EVENT, restored);
  }, [projectRoot]);

  useEffect(() => {
    const clear = (event: Event) => {
      const { projectRoot: root, agent } = (
        event as CustomEvent<{ projectRoot: string; agent: boolean }>
      ).detail;
      const snapshot = current.current;
      if (!snapshot || snapshot.root !== root) return;
      invalidateProjectCommentSnapshot(root);
      snapshot.files = Object.fromEntries(
        Object.entries(snapshot.files).map(([path, comments]) => [
          path,
          comments.filter((comment) => Boolean(comment.origin) !== agent),
        ]),
      );
      snapshot.counters[agent ? 1 : 0] = 0;
      setFiles(snapshot.files);
      setReload((value) => value + 1);
    };
    window.addEventListener(COMMENTS_CLEARED_EVENT, clear);
    return () => window.removeEventListener(COMMENTS_CLEARED_EVENT, clear);
  }, []);

  useEffect(
    () => () => {
      current.current = null;
    },
    [],
  );

  useEffect(() => {
    const refresh = (event: Event) => {
      const requestedRoot = (event as CustomEvent<{ projectRoot: string }>)
        .detail.projectRoot;
      if (requestedRoot === projectRoot) refreshComments();
    };
    window.addEventListener(PROJECT_COMMENTS_REFRESH_EVENT, refresh);
    return () =>
      window.removeEventListener(PROJECT_COMMENTS_REFRESH_EVENT, refresh);
  }, [projectRoot, refreshComments]);

  useEffect(() => {
    if (current.current?.root !== projectRoot) current.current = null;
    // A same-project reload must not remove comment widgets between reads.
    // Saves trigger filesystem notifications too; clearing here causes a flash
    // and shifts the editor scroll position before the comments return.
    if (loadedRoot !== projectRoot) {
      setLoadedRoot(null);
      setFiles({});
      setDisconnected({});
    }
    if (!projectRoot) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    const buffered: CommentPatch[] = [];
    const snapshot = current.current ?? {
      root: projectRoot,
      files: {} as InlineCommentsByFile,
      blocked: false,
      counters: [0, 0],
    };
    const beforeRead = snapshot.files;
    let loadedCounters = snapshot.counters;
    let loadedDisconnected: InlineCommentsByFile = {};
    listen<CommentChangeEvent>("catalex-comments-changed", ({ payload }) => {
      if (cancelled || payload.projectRoot !== projectRoot) return;
      invalidateProjectCommentSnapshot(projectRoot);
      const patches = payload.patches ?? [payload.patch];
      if (current.current !== snapshot) {
        buffered.push(...patches);
        return;
      }
      const active = patches.filter(
        (patch) =>
          !wasCommentCleared(projectRoot, patch.id) &&
          !(
            !patch.before &&
            patch.after &&
            isCommentPendingDeletion(projectRoot, patch.id)
          ),
      );
      for (const patch of active) {
        reconnectTrackedComments(projectRoot, [patch.id], patch.filePath);
        patch.filePath = resolveCommentPath(
          projectRoot,
          patch.id,
          patch.filePath,
        );
        if (patch.after) rememberComment(projectRoot, patch.after);
      }
      const before = snapshot.files;
      snapshot.files = applyCommentPatches(snapshot.files, active);
      if (!payload.historyReplay)
        for (const patch of commentHistoryPatches(before, snapshot.files))
          onChangeRef.current?.(patch);
      snapshot.files = previewNumbers(
        snapshot.files,
        snapshot.counters,
        before,
      );
      if (snapshot.files !== before) setFiles(snapshot.files);
    })
      .then(async (unlisten) => {
        stop = unlisten;
        if (cancelled) {
          unlisten();
          return {};
        }
        const loaded = await loadProjectCommentSnapshot(
          projectRoot,
          includeDisconnected,
        );
        // Number previews mutate this view's counters, not the shared read.
        loadedCounters = [...loaded.counters];
        loadedDisconnected = loaded.disconnected;
        return loaded.files;
      })
      .then((loaded) => {
        if (cancelled) return;
        // File-map identity is the revision: updates replace it, typing stays
        // in the shared draft store. Never install a read over a newer action.
        if (current.current === snapshot && snapshot.files !== beforeRead) {
          setReload((value) => value + 1);
          return;
        }
        snapshot.counters = loadedCounters;
        snapshot.blocked = false;
        snapshot.files = previewNumbers(
          applyCommentPatches(loaded, buffered),
          snapshot.counters,
        );
        current.current = snapshot;
        setFiles(snapshot.files);
        setDisconnected(loadedDisconnected);
        setLoadedRoot(projectRoot);
      })
      .catch((error) => {
        if (!cancelled)
          toast.error(`Comments could not be loaded: ${String(error)}`, {
            action: {
              label: "Retry",
              onClick: () => setReload((value) => value + 1),
            },
          });
      });
    return () => {
      cancelled = true;
      // Reopening this root must not join a request from the closed view.
      invalidateProjectCommentSnapshot(projectRoot);
      stop?.();
    };
  }, [projectRoot, reload, includeDisconnected]);

  useEffect(() => {
    const record = (event: Event) => {
      const detail = (
        event as CustomEvent<{ root: string; patches: CommentPatch[] }>
      ).detail;
      if (detail.root !== projectRoot) return;
      const snapshot = current.current;
      for (const patch of detail.patches) {
        if (snapshot) {
          const comment =
            patch.after ??
            patch.before ??
            patch.draft?.after?.comment ??
            patch.draft?.before?.comment;
          if (comment) rememberComment(snapshot.root, comment);
        }
        onChangeRef.current?.(patch);
      }
      if (snapshot) {
        snapshot.files = previewNumbers(
          applyCommentPatches(
            snapshot.files,
            detail.patches.filter((patch) => !patch.draftOnly),
          ),
          snapshot.counters,
          snapshot.files,
        );
        setFiles(snapshot.files);
      }
    };
    window.addEventListener("catalex-comment-range-changed", record);
    window.addEventListener(COMMENT_HISTORY_EVENT, record);
    return () => {
      window.removeEventListener("catalex-comment-range-changed", record);
      window.removeEventListener(COMMENT_HISTORY_EVENT, record);
    };
  }, [projectRoot]);

  const retrySaving = useCallback(
    (snapshot: NonNullable<typeof current.current>) => {
      if (current.current !== snapshot) return;
      void flushProjectCommentWrites(snapshot.root)
        .then(() => {
          if (current.current !== snapshot) return;
          snapshot.blocked = false;
          toast.dismiss(`comment-save:${snapshot.root}`);
          setReload((value) => value + 1);
        })
        .catch((error) =>
          showCommentSaveError(snapshot.root, error, () =>
            retrySaving(snapshot),
          ),
        );
    },
    [],
  );

  const update = useCallback(
    (action: SetStateAction<InlineCommentsByFile>, rangeChange = false) => {
      const snapshot = current.current;
      if (!snapshot) return;
      const before = snapshot.files;
      // A draft opened in the other pane may not yet exist in persisted files.
      // Apply save/delete actions to the same draft-inclusive view the UI uses.
      const displayed = projectCommentDrafts(snapshot.root, before);
      const updated = typeof action === "function" ? action(displayed) : action;
      if (before === updated) return;
      const after = previewNumbers(updated, snapshot.counters, before);
      snapshot.files = after;
      if (rangeChange) {
        window.dispatchEvent(
          new CustomEvent("catalex-comment-range-changed", {
            detail: {
              root: snapshot.root,
              patches: commentPatches(before, after),
            },
          }),
        );
      } else {
        const patches = commentHistoryPatches(before, after);
        const changedIds = new Set(
          patches.map((patch) => JSON.stringify([patch.filePath, patch.id])),
        );
        for (const [filePath, comments] of Object.entries(displayed)) {
          const remainingIds = new Set(
            (after[filePath] ?? []).map((comment) => comment.id),
          );
          for (const comment of comments) {
            if (
              remainingIds.has(comment.id) ||
              changedIds.has(JSON.stringify([filePath, comment.id]))
            )
              continue;
            const draft = getCommentDraft(
              { root: snapshot.root, filePath },
              comment.id,
            );
            if (draft)
              patches.push({
                filePath,
                id: comment.id,
                before: null,
                after: null,
                draftOnly: true,
              });
          }
        }
        for (const patch of patches) {
          const scope = { root: snapshot.root, filePath: patch.filePath };
          const draft = getCommentDraft(scope, patch.id);
          if (draft) {
            patch.draft = { before: { ...draft }, after: null };
            setCommentDraft(scope, patch.id, null);
          }
        }
        if (patches.length)
          window.dispatchEvent(
            new CustomEvent(COMMENT_HISTORY_EVENT, {
              detail: { root: snapshot.root, patches },
            }),
          );
      }
      setFiles(after);
      void saveProjectInlineComments(snapshot.root, before, after)
        .then(() => {
          if (
            current.current !== snapshot ||
            getUnsavedCommentFiles(snapshot.root).length
          )
            return;
          snapshot.blocked = false;
          toast.dismiss(`comment-save:${snapshot.root}`);
        })
        .catch((error) => {
          if (current.current !== snapshot || snapshot.blocked) return;
          snapshot.blocked = true;
          showCommentSaveError(snapshot.root, error, () =>
            retrySaving(snapshot),
          );
        });
    },
    [retrySaving],
  );
  const canReplay = useCallback(() => {
    if (!current.current) {
      toast.error(
        "Comments must be reloaded before undoing or redoing changes.",
        {
          id: "comment-replay-unavailable",
          action: {
            label: "Reload comments",
            onClick: () => setReload((value) => value + 1),
          },
        },
      );
      return false;
    }
    return true;
  }, []);
  const replay = useCallback(
    (patch: CommentPatch) => {
      const snapshot = current.current;
      if (!snapshot) {
        canReplay();
        return;
      }
      if (wasCommentCleared(snapshot.root, patch.id)) return;
      if (isCommentDetached(snapshot.root, patch.id)) {
        warnSkippedCommentReplay(snapshot.root);
        return;
      }
      patch = {
        ...patch,
        filePath: resolveCommentPath(snapshot.root, patch.id, patch.filePath),
      };
      breakCommentTypingGroup();
      const applyDraft = () => {
        if (patch.draft)
          setCommentDraft(
            {
              root: snapshot.root,
              filePath: resolveCommentPath(
                snapshot.root,
                patch.id,
                patch.filePath,
              ),
            },
            patch.id,
            patch.draft.after,
          );
      };
      void replayProjectComment(snapshot.root, patch, (change) => {
        applyDraft();
        if (current.current !== snapshot) return;
        if (!patch.draftOnly) {
          snapshot.files = previewNumbers(
            applyCommentPatch(snapshot.files, change),
            snapshot.counters,
            snapshot.files,
          );
          setFiles(snapshot.files);
        }
      })
        .then(() => {
          if (
            current.current !== snapshot ||
            getUnsavedCommentFiles(snapshot.root).length
          )
            return;
          snapshot.blocked = false;
          toast.dismiss(`comment-save:${snapshot.root}`);
        })
        .catch((error) => {
          if (current.current !== snapshot) return;
          snapshot.blocked = true;
          showCommentSaveError(snapshot.root, error, () =>
            retrySaving(snapshot),
          );
        });
    },
    [retrySaving, canReplay],
  );
  const displayedFiles = useMemo(
    () => projectCommentDrafts(projectRoot, files),
    [projectRoot, files, draftRevision],
  );
  return [
    displayedFiles,
    update,
    replay,
    Boolean(projectRoot && loadedRoot === projectRoot),
    canReplay,
    disconnected,
  ] as const;
}

// Display-only predictions: serialization deliberately excludes expectedNumber.
// Saved numbers remain authoritative if another writer saves first.
function previewNumbers(
  files: InlineCommentsByFile,
  counters: number[],
  before?: InlineCommentsByFile,
) {
  if (files === before) return files;
  let changed = !before;
  for (const path of new Set([
    ...Object.keys(files),
    ...Object.keys(before ?? {}),
  ])) {
    const comments = files[path] ?? [];
    const previous = before?.[path];
    if (comments === previous) continue;
    if (comments.length !== (previous?.length ?? 0)) changed = true;
    for (let index = 0; index < comments.length; index++) {
      const comment = comments[index];
      const old = previous?.[index];
      if (comment === old) continue;
      if (
        comment.id !== old?.id ||
        comment.number !== old.number ||
        Boolean(comment.origin) !== Boolean(old.origin)
      )
        changed = true;
      const kind = comment.origin ? 1 : 0;
      counters[kind] = Math.max(counters[kind] ?? 0, comment.number ?? 0);
    }
  }
  // Text, anchor and status updates reuse previews. A changed list/order or an
  // assigned number rebuilds draft predictions; reloads check every record.
  if (!changed) return files;
  const next = [...counters];
  let result = files;
  for (const [path, comments] of Object.entries(files)) {
    let changed = false;
    const numbered = comments.map((comment) => {
      if (comment.number != null) return comment;
      const expectedNumber = ++next[comment.origin ? 1 : 0];
      if (comment.expectedNumber === expectedNumber) return comment;
      changed = true;
      return { ...comment, expectedNumber };
    });
    if (changed) {
      if (result === files) result = { ...files };
      result[path] = numbered;
    }
  }
  return result;
}
