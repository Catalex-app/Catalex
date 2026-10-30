import { HARNESSES } from "@/lib/agent-harness";
import { useEffect } from "react";
import { listen, type UnlistenFn } from "@/lib/desktop/event";
import type { CommentChangeEvent } from "@/components/workspace/editor/inline-comment-storage";
import { useSettingsStore } from "@/stores/settings-store";

// Saved comments survive failed/interrupted turns too. Reveal them once the
// producing turn ends, never on each individual save or an ordinary chat turn.
export function useAgentCommentReveal() {
  useEffect(() => {
    const pending = new Map<string, string>();
    const stops: UnlistenFn[] = [];
    let cancelled = false;
    const register = (registration: Promise<UnlistenFn>) => {
      void registration
        .then((stop) => {
          if (cancelled) stop();
          else stops.push(stop);
        })
        .catch((error) =>
          console.error("Comment reveal listener failed", error),
        );
    };
    register(
      listen<CommentChangeEvent>("catalex-comments-changed", ({ payload }) => {
        if (
          cancelled ||
          !payload.tabId ||
          payload.patch.before ||
          !payload.patch.after?.origin
        )
          return;
        pending.set(payload.tabId, payload.projectRoot);
      }),
    );
    for (const event of Object.keys(HARNESSES).map(
      (provider) => `${provider}-complete`,
    )) {
      register(
        listen<{ tab_id: string }>(event, ({ payload }) => {
          if (cancelled) return;
          const projectRoot = pending.get(payload.tab_id);
          pending.delete(payload.tab_id);
          if (!projectRoot) return;
          const key = JSON.stringify(projectRoot);
          // Project-scoped state also survives editor remounts when returning
          // from the agent draft to source, without changing another project.
          useSettingsStore.setState((state) => ({
            editorCommentsPanelOpenByProject: {
              ...state.editorCommentsPanelOpenByProject,
              [key]: true,
            },
            editorCommentFilterByProject: {
              ...state.editorCommentFilterByProject,
              [key]: "agent",
            },
          }));
        }),
      );
    }
    return () => {
      cancelled = true;
      pending.clear();
      for (const stop of stops) stop();
    };
  }, []);
}
