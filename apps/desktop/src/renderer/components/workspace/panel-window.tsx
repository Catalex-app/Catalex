import { ErrorBoundary } from "react-error-boundary";
import { ErrorFallback } from "@/components/error-fallback";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useEffect } from "react";
import { ArrowUpRightIcon, MessagesSquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useAgentChatStore,
  lastCommunicationProvider,
} from "@/stores/agent-chat-store";
import { ThemeProvider } from "next-themes";
import { toast } from "sonner";
import { getPanelWindowSession } from "@/lib/panel-window-runtime";
import { useDocumentStore } from "@/stores/document-store";
import { isMarkdownFile } from "@/lib/markdown";
import { useWorkspaceTheme } from "@/hooks/use-workspace-theme";
import { getCurrentWindow } from "@/lib/desktop/window";
import { hostInvoke } from "@/lib/desktop/bridge";
import { TrafficLightSafeHeader } from "@/components/window-titlebar";
import { Hint, TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { LatexEditor } from "./editor/latex-editor";
import { PdfPreview } from "./preview/pdf-preview";
import { MarkdownPreview } from "./preview/markdown-preview";
import { CsvTable } from "./preview/csv-table";
import { ChatWorkspacePane } from "../agent-chat/chat-workspace-pane";
import { WorkspacePanel } from "./workspace-panel";
import { flushProjectCommentWrites } from "./editor/inline-comment-storage";

function PanelContent() {
  const session = getPanelWindowSession();
  if (!session) throw new Error("The owning workspace is no longer available.");
  useWorkspaceTheme(session.mode);
  useKeyboardShortcuts();
  const file = useDocumentStore((state) =>
    state.files.find((file) => file.id === session.fileId),
  );
  const chatTitle = useAgentChatStore(
    (state) =>
      state.tabs.find((tab) => tab.id === state.activeTabId)?.title ??
      "New Chat",
  );
  const provider = useAgentChatStore((state) =>
    lastCommunicationProvider(
      state.tabs.find((tab) => tab.id === state.activeTabId),
    ),
  );
  const expansion = {
    label:
      session.kind === "chat"
        ? "Chat"
        : session.kind === "editor"
          ? file?.type === "csv"
            ? "Raw"
            : "Editor"
          : file?.type === "csv"
            ? "Table"
            : isMarkdownFile(file)
              ? "Preview"
              : "PDF",
    expanded: false,
  };
  const windowTitle =
    session.kind === "chat" ? chatTitle : (file?.name ?? "Panel");
  const projectName =
    session.projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? "Project";
  const showProject = async () => {
    try {
      if (window.catalex) {
        if (!(await hostInvoke<boolean>("desktop:window:focusOwner")))
          throw new Error("The project window is no longer available.");
      } else if (window.opener && !window.opener.closed) {
        window.opener.focus();
      } else {
        throw new Error("The project window is no longer available.");
      }
    } catch (error) {
      toast.error(`Could not show project window: ${String(error)}`);
    }
  };
  useEffect(() => {
    const flush = async () => {
      const state = session.document.getState();
      if (
        state.projectRoot === session.projectRoot &&
        !state.agentWorkspaceRoot
      )
        await state.saveAllFiles({ requireClean: true });
      await flushProjectCommentWrites(session.projectRoot);
    };
    session.flush = flush;
    const host = getCurrentWindow();
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try {
        await flush();
        if (window.catalex) await host.close();
        else window.close();
      } catch (error) {
        closing = false;
        toast.error(`Could not save: ${String(error)}`);
      }
    };
    session.close = close;
    const stop = window.catalex
      ? host.onCloseRequested(async (event) => {
          event.preventDefault();
          await close();
        })
      : Promise.resolve(() => {});
    return () => {
      if (session.flush === flush) session.flush = undefined;
      if (session.close === close) session.close = undefined;
      void stop.then((unlisten) => unlisten());
    };
  }, [session]);
  useEffect(() => {
    document.title = windowTitle;
    if (window.catalex) void getCurrentWindow().setTitle(windowTitle);
  }, [windowTitle]);
  return (
    <div
      className="flex h-screen min-w-0 flex-col overflow-clip bg-background text-foreground"
      data-panel-window={session.kind}
    >
      <TrafficLightSafeHeader
        trailing={
          <Hint content="Show project window">
            <Button
              variant="ghost"
              size="sm"
              className="ml-3 h-7 max-w-[40%] gap-1.5 border border-border/60 bg-muted/60 text-muted-foreground text-xs"
              aria-label={`Show project window: ${projectName}`}
              onClick={() => void showProject()}
            >
              <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
              <span className="truncate">{projectName}</span>
            </Button>
          </Hint>
        }
      >
        <span
          data-panel-window-title=""
          className="ml-3 flex min-w-0 items-center gap-2 font-medium text-sm"
          title={windowTitle}
        >
          {session.kind === "chat" && (
            <MessagesSquareIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0",
                provider === "codex"
                  ? "text-blue-500"
                  : provider === "claude"
                    ? "text-amber-500"
                    : provider === "pi"
                      ? "text-emerald-500"
                      : "text-muted-foreground",
              )}
            />
          )}
          <span className="truncate">{windowTitle}</span>
        </span>
      </TrafficLightSafeHeader>
      <div className="min-h-0 flex-1 px-2 pb-2">
        {session.kind === "editor" ? (
          <LatexEditor
            suppressToolbar
            expansion={expansion}
            assistantMode={session.mode}
            chatLayout="workspace"
          />
        ) : session.kind === "chat" ? (
          <ChatWorkspacePane expansion={expansion} />
        ) : (
          <WorkspacePanel
            expansion={expansion}
            className="h-full"
            data-workspace-panel-screen="true"
          >
            {file?.type === "csv" ? (
              <CsvTable />
            ) : isMarkdownFile(file) ? (
              <MarkdownPreview editorVisible={false} />
            ) : (
              <PdfPreview editorVisible={false} />
            )}
          </WorkspacePanel>
        )}
      </div>
    </div>
  );
}

export function PanelWindow() {
  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
        <TooltipProvider>
          <PanelContent />
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
