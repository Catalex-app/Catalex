import { useProjectActions } from "@/hooks/use-project-actions";
import { PRODUCT_NAME } from "../branding";
import { waitForCommentsOnClose } from "@/lib/comment-close-wait";
import { CommentCloseDialog } from "@/components/comment-close-dialog";
import { ProjectChangedDialog } from "@/components/agent-chat/agent-question-prompt";
import { Onboarding } from "@/components/onboarding";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useAgentEvents } from "@/hooks/use-agent-events";
import { toast } from "sonner";
import {
  CommentSaveExitError,
  ProjectExitCanceled,
  prepareProjectExit,
  subscribeProjectChats,
} from "@/lib/project-chat-lifecycle";
import { ThemeProvider } from "next-themes";
import { ErrorBoundary } from "react-error-boundary";
import { GitCredentialRecovery } from "@/components/workspace/git-credential-recovery";
import { Toaster } from "@/components/ui/sonner";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useProjectFileWatch } from "@/hooks/use-project-file-watch";

import { useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import {
  getProposedChangesProjectKey,
  useProposedChangesStore,
} from "@/stores/proposed-changes-store";
import { ProjectPicker } from "@/components/project-picker";
import { HistoryWorkspace } from "@/components/workspace/history-workspace";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { lazy, Suspense, useEffect, useLayoutEffect, useState } from "react";
import { getCurrentWindow } from "@/lib/desktop/window";
import { ask } from "@/lib/desktop/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorFallback } from "@/components/error-fallback";
import { SolarModeEffect } from "@/components/settings/solar-mode-effect";

const LazyDebugPage = lazy(() =>
  import("@/components/debug/debug-page").then((m) => ({
    default: m.DebugPage,
  })),
);

function WorkspaceWithAgent() {
  useAgentEvents();
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const initialized = useDocumentStore((s) => s.initialized);
  const activeProposalProjectRoot = useProposedChangesStore(
    (state) => state.activeProjectRoot,
  );
  const expectedProposalProjectRoot = getProposedChangesProjectKey(projectRoot);

  useLayoutEffect(() => {
    useProposedChangesStore.getState().activateProject(projectRoot);
    return () => {
      if (
        useProposedChangesStore.getState().activeProjectRoot ===
        expectedProposalProjectRoot
      ) {
        useProposedChangesStore.getState().activateProject(null);
      }
    };
  }, [expectedProposalProjectRoot, projectRoot]);

  // Update window title
  useEffect(() => {
    if (projectRoot && !navigator.userAgent.includes("Macintosh")) {
      const name = projectRoot.split(/[/\\]/).pop() || PRODUCT_NAME;
      getCurrentWindow().setTitle(`${name} - ${PRODUCT_NAME}`);
    }
  }, [projectRoot]);

  // Consume pending initial prompt from project wizard
  useEffect(() => {
    if (!initialized) return;
    // Delay to let AgentChatDrawer mount and register event listeners
    const timer = setTimeout(() => {
      const prompt = useAgentChatStore.getState().consumePendingInitialPrompt();
      if (prompt) {
        useAgentChatStore.getState().sendPrompt(prompt);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [initialized]);

  if (activeProposalProjectRoot !== expectedProposalProjectRoot) return null;

  return (
    <HistoryWorkspace>
      <WorkspaceLayout />
    </HistoryWorkspace>
  );
}

export function App({ onReady }: { onReady?: () => void }) {
  useProjectFileWatch();
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const [showDebug, setShowDebug] = useState(false);
  const [closeFailure, setCloseFailure] = useState<{
    waiting?: boolean;
    cancel?: () => void;
    retry: () => void;
    discard: () => void;
  } | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const onboardingCompleted = useOnboardingStore((s) => s.completed);
  useProjectActions(onboardingCompleted && !showDebug && !closeBusy);

  useEffect(() => {
    const unsubscribe = subscribeProjectChats((error) => {
      toast.error(`Could not save chats: ${String(error)}`, {
        id: "chat-save-error",
      });
    });
    let disposed = false;
    let closing = false;
    let closeApproved = false;
    let unlisten: (() => void) | undefined;
    const attemptClose = async (skipCommentWrites = false) => {
      if (closing) return;
      closing = true;
      setCloseBusy(true);
      try {
        // Skipping failed comment writes still saves manuscript/chat edits.
        await prepareProjectExit({
          skipCommentWrites,
          waitForComments: (saving) =>
            waitForCommentsOnClose(saving, (choices) => {
              setCloseBusy(choices === null);
              setCloseFailure(
                choices
                  ? {
                      waiting: true,
                      retry: choices.wait,
                      discard: choices.discard,
                      cancel: choices.cancel,
                    }
                  : null,
              );
            }),
        });
        closeApproved = true;
        await getCurrentWindow().close();
      } catch (error) {
        closeApproved = false;
        useAgentChatStore.setState({ isLeavingProject: false });
        if (error instanceof ProjectExitCanceled) {
          setCloseFailure(null);
        } else if (error instanceof CommentSaveExitError) {
          setCloseFailure({
            retry: () => void attemptClose(),
            discard: () => void attemptClose(true),
          });
        } else {
          setCloseFailure(null);
          try {
            const discard = await ask(
              `Some changes could not be saved. Closing now may lose unsaved manuscript, chat, and comment changes. Stay open to copy anything you need.\n\n${String(error)}`,
              {
                title: "Close without saving?",
                kind: "warning",
                okLabel: "Close anyway",
                cancelLabel: "Stay open",
                defaultButton: "cancel",
              },
            );
            if (discard) {
              closeApproved = true;
              await getCurrentWindow().close();
            }
          } catch (closeError) {
            closeApproved = false;
            toast.error(`Could not close the window: ${String(closeError)}`);
          }
        }
      } finally {
        closing = false;
        setCloseBusy(false);
      }
    };
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (closeApproved) return;
        event.preventDefault();
        await attemptClose();
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
      unsubscribe();
    };
  }, []);

  // Register global keyboard shortcuts (Cmd+S, Cmd+N) at the app level
  useKeyboardShortcuts();

  useEffect(() => {
    onReady?.();
  }, [onReady]);

  // Listen for debug panel toggle (Ctrl+Shift+D)
  useEffect(() => {
    const handler = () => setShowDebug((prev) => !prev);
    window.addEventListener("toggle-debug-panel", handler);
    return () => window.removeEventListener("toggle-debug-panel", handler);
  }, []);

  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
        <TooltipProvider>
          <SolarModeEffect />
          <ProjectChangedDialog />
          <CommentCloseDialog
            projectRoot={projectRoot}
            open={closeFailure !== null}
            busy={closeBusy}
            waiting={closeFailure?.waiting}
            onCancel={() => {
              if (closeFailure?.cancel) closeFailure.cancel();
              else setCloseFailure(null);
            }}
            onRetry={() => closeFailure?.retry()}
            onDiscard={() => closeFailure?.discard()}
          />
          {!onboardingCompleted ? (
            <Onboarding />
          ) : (
            <div className="h-full bg-background" data-project-screen>
              {projectRoot ? <WorkspaceWithAgent /> : <ProjectPicker />}
            </div>
          )}
          {showDebug && (
            <div className="fixed inset-0 z-[9998] flex items-end justify-center">
              <div
                className="absolute inset-0 bg-black/20"
                onClick={() => setShowDebug(false)}
              />
              <div className="relative h-[60vh] w-full border-border border-t bg-background shadow-lg">
                <div className="flex h-8 items-center justify-between border-border border-b bg-muted/50 px-3">
                  <span className="font-medium text-xs">Debug Panel</span>
                  <button
                    className="text-muted-foreground text-xs hover:text-foreground"
                    onClick={() => setShowDebug(false)}
                  >
                    Close (Ctrl+Shift+D)
                  </button>
                </div>
                <div className="h-[calc(60vh-2rem)] overflow-auto">
                  <Suspense
                    fallback={
                      <div className="p-4 text-muted-foreground text-sm">
                        Loading...
                      </div>
                    }
                  >
                    <LazyDebugPage />
                  </Suspense>
                </div>
              </div>
            </div>
          )}
          <GitCredentialRecovery />
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
