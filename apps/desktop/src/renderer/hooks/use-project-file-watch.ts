import {
  synchronizeProjectCommentAnchors,
  receiveCommentsCleared,
} from "@/components/workspace/editor/inline-comment-storage";
import { useEffect } from "react";
import { invoke } from "@/lib/desktop/core";
import { listen } from "@/lib/desktop/event";
import { toast } from "sonner";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";

interface FileChanges {
  projectRoot: string;
  watchId: string;
  paths: string[];
  rescan: boolean;
}

export function useProjectFileWatch() {
  const root = useDocumentStore((state) => state.projectRoot);
  const workspace = useDocumentStore((state) => state.agentWorkspaceRoot);
  const gitRunning = useDocumentStore((state) => state.isGitOperationRunning);
  useEffect(() => {
    if (!root) return;
    const watchId = crypto.randomUUID();
    let disposed = false;
    let running = false;
    let full = false;
    let rescan = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const paths = new Set<string>();
    const stops: Array<() => void> = [];
    const drain = async () => {
      timer = undefined;
      if (disposed || running) return;
      running = true;
      const batch = full ? undefined : [...paths];
      const scan = rescan;
      paths.clear();
      full = false;
      rescan = false;
      try {
        const entry = useAgentReviewQueueStore
          .getState()
          .entries.find(
            (entry) =>
              entry.session.projectRoot === root && entry.phase === "review",
          );
        if (entry) {
          await useAgentReviewQueueStore
            .getState()
            .checkProject(entry.session.sessionId);
          return;
        }
        await useDocumentStore.getState().refreshExternalFiles(batch, scan);
        const current = useDocumentStore.getState();
        if (
          !disposed &&
          current.projectRoot === root &&
          !current.agentWorkspaceRoot &&
          !current.isGitOperationRunning
        )
          await synchronizeProjectCommentAnchors(root);
      } catch (error) {
        if (!disposed)
          toast.error(`Could not refresh project files: ${String(error)}`);
      } finally {
        running = false;
        if (!disposed && (full || paths.size || rescan))
          timer = setTimeout(drain, 200);
      }
    };
    const enqueue = (changed?: string[], scan = false) => {
      if (disposed) return;
      if (changed) for (const path of changed) paths.add(path);
      else full = true;
      rescan ||= scan;
      if (!timer) timer = setTimeout(drain, 200);
    };
    const focus = () => enqueue(undefined, true);
    window.addEventListener("focus", focus);
    const visible = () => {
      if (document.visibilityState === "visible") focus();
    };
    document.addEventListener("visibilitychange", visible);
    void (async () => {
      try {
        const stop = await listen<FileChanges>(
          "project-files-changed",
          ({ payload }) => {
            if (payload.projectRoot === root && payload.watchId === watchId)
              enqueue(
                payload.rescan &&
                  (payload.paths.length === 0 || payload.paths.includes(""))
                  ? undefined
                  : payload.paths,
                payload.rescan,
              );
          },
        );
        if (disposed) {
          stop();
          return;
        }
        stops.push(stop);
        const stopComments = await listen<{
          projectRoot: string;
          agent: boolean;
        }>("catalex-comments-cleared", ({ payload }) => {
          if (payload.projectRoot === root)
            receiveCommentsCleared(root, payload.agent);
        });
        if (disposed) {
          stopComments();
          return;
        }
        stops.push(stopComments);
        await invoke("watch_project_files", { projectRoot: root, watchId });
        if (disposed) await invoke("unwatch_project_files", { watchId });
        else focus();
      } catch (error) {
        if (!disposed) {
          toast.warning(
            `Live file updates are unavailable. Files will be checked when you return to the app. ${String(error)}`,
          );
          focus();
        }
      }
    })();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visible);
      for (const stop of stops) stop();
      void invoke("unwatch_project_files", { watchId }).catch(() => {});
    };
  }, [root, workspace, gitRunning]);
}
