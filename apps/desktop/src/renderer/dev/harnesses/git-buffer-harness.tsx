import { useEffect, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Sidebar } from "@/components/workspace/sidebar";
import { LatexEditor } from "@/components/workspace/editor/latex-editor";
import { GitActionsControl } from "@/components/workspace/git-actions-control";
import { useDocumentStore } from "@/stores/document-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

// Playwright supplies a bridge to disposable repositories. The editor, document
// store, Git controls and sidebar below are the actual application components.
declare global {
  interface Window {
    __gitBufferRoot?: string;
    __gitBufferInvoke?: (
      command: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
  }
}

ensureDesktopBrowserMocks();
const internals = (
  window as unknown as {
    __TAURI_INTERNALS__: {
      invoke: (
        command: string,
        args?: unknown,
        options?: { headers?: Record<string, string> },
      ) => Promise<unknown>;
    };
  }
).__TAURI_INTERNALS__;
const fallback = internals.invoke;
internals.invoke = async (command, args = {}, options) => {
  if (
    window.__gitBufferInvoke &&
    (command.startsWith("git_panel_") ||
      command.startsWith("history_") ||
      command === "save_file_if_unchanged" ||
      command === "git_worktree_file_line_stats" ||
      command === "plugin:path|join" ||
      command.startsWith("plugin:fs|"))
  ) {
    const payload =
      command === "plugin:fs|write_text_file"
        ? {
            path: decodeURIComponent(options?.headers?.path ?? ""),
            content: new TextDecoder().decode(args as Uint8Array),
          }
        : (args as Record<string, unknown>);
    return window.__gitBufferInvoke(command, payload);
  }
  return fallback(command, args as Record<string, unknown>, options);
};

export function GitBufferHarness() {
  const [ready, setReady] = useState(false);
  const projectRoot = window.__gitBufferRoot;
  useEffect(() => {
    if (!projectRoot) return;
    useDocumentStore.setState({
      projectRoot,
      files: [],
      folders: [],
      activeFileId: "main.tex",
      openFileIds: ["main.tex"],
      initialized: true,
      agentWorkspaceRoot: null,
      isAgentWorkspaceReadOnly: false,
    });
    void useDocumentStore
      .getState()
      .refreshFiles()
      .then(() => setReady(true));
  }, [projectRoot]);
  if (!projectRoot || !ready)
    return <p>Waiting for the Git buffer test repository...</p>;
  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background text-foreground">
        <div className="w-80 shrink-0 border-r">
          <Sidebar disableInteractiveIntegrations />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex justify-end border-b p-3">
            <GitActionsControl projectPath={projectRoot} />
          </div>
          <div className="min-h-0 flex-1">
            <LatexEditor suppressToolbar />
          </div>
        </div>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
