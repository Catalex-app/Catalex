import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AppWindowIcon,
  CopyIcon,
  FolderOpenIcon,
  MessagesSquareIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  SessionStatusIndicator,
  useSessionStatus,
} from "@/components/agent-chat/session-status";
import {
  openChatPanelSnapshot,
  subscribePanelSessions,
} from "@/lib/panel-window-runtime";
import { pinFileToChat, selectionChatTargets } from "@/lib/selection-chat";
import { toast } from "sonner";
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { openPanelWindow } from "@/lib/panel-windows";
import { browserHarness } from "@/lib/desktop/bridge";
import { invoke } from "@/lib/desktop/core";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";

/** Pin the whole file to the chosen draft without opening or switching chats. */
export function sendSidebarFileToChat(
  file: ProjectFile,
  tabId: string,
  projectRoot: string,
) {
  return pinFileToChat(
    tabId,
    file.relativePath,
    file.content ?? "",
    projectRoot,
  );
}

export function SidebarFileContextActions({
  file,
  aiEnabled,
  chatMenuOpen = false,
  onChatMenuOpenChange,
  children,
}: {
  file: ProjectFile;
  aiEnabled: boolean;
  chatMenuOpen?: boolean;
  onChatMenuOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}) {
  const projectRoot = useDocumentStore((state) => state.projectRoot);
  const activeFileId = useDocumentStore((state) => state.activeFileId);
  const tabs = useAgentChatStore((state) => state.tabs);
  const activeTabId = useAgentChatStore((state) => state.activeTabId);
  const chatProjectRoot = useAgentChatStore((state) => state.chatProjectRoot);
  const openPanels = useSyncExternalStore(
    subscribePanelSessions,
    openChatPanelSnapshot,
  );
  const targets =
    aiEnabled &&
    file.id !== activeFileId &&
    projectRoot &&
    chatProjectRoot === projectRoot
      ? selectionChatTargets(tabs, activeTabId, openPanels)
      : [];
  const getStatus = useSessionStatus();
  const sendRef = useRef<HTMLDivElement>(null);
  const firstTargetRef = useRef<HTMLDivElement>(null);
  const wasChatMenuOpen = useRef(false);
  useLayoutEffect(() => {
    if (chatMenuOpen) firstTargetRef.current?.focus();
    else if (wasChatMenuOpen.current) sendRef.current?.focus();
    wasChatMenuOpen.current = chatMenuOpen;
  }, [chatMenuOpen]);
  useEffect(() => {
    if (chatMenuOpen && targets.length <= 1) onChatMenuOpenChange?.(false);
  }, [chatMenuOpen, targets.length, onChatMenuOpenChange]);
  const sendFile = (tabId: string) =>
    Boolean(projectRoot && sendSidebarFileToChat(file, tabId, projectRoot));
  const reportFailure = (action: string, error: unknown) => {
    toast.error(
      `${action}: ${error instanceof Error ? error.message : String(error)}`,
    );
  };
  if (chatMenuOpen)
    return (
      <>
        <ContextMenuItem
          aria-label="Back to file actions"
          textValue="Send to chat"
          onSelect={(event) => {
            event.preventDefault();
            onChatMenuOpenChange?.(false);
          }}
        >
          <ChevronLeftIcon className="mr-2 size-4" />
          Send to chat
        </ContextMenuItem>
        <ContextMenuSeparator />
        {targets.map(({ tab, location }, index) => (
          <ContextMenuItem
            key={tab.id}
            ref={index === 0 ? firstTargetRef : undefined}
            textValue={tab.title || "New chat"}
            onSelect={(event) => {
              if (!sendFile(tab.id)) event.preventDefault();
            }}
          >
            <SessionStatusIndicator status={getStatus(tab)} />
            <span className="min-w-0 flex-1 truncate">
              {tab.title || "New chat"}
            </span>
            <Badge
              variant="secondary"
              className="shrink-0 px-1.5 py-0 text-[10px]"
            >
              {location}
            </Badge>
          </ContextMenuItem>
        ))}
      </>
    );
  return (
    <>
      {targets.length > 0 && (
        <>
          <ContextMenuItem
            ref={sendRef}
            aria-label="Send to chat"
            aria-haspopup={targets.length > 1 ? "menu" : undefined}
            textValue="Send to chat"
            onSelect={(event) => {
              if (targets.length === 1) {
                if (!sendFile(targets[0].tab.id)) event.preventDefault();
              } else {
                event.preventDefault();
                onChatMenuOpenChange?.(true);
              }
            }}
            onKeyDown={(event) => {
              if (targets.length > 1 && event.key === "ArrowRight") {
                event.preventDefault();
                event.stopPropagation();
                onChatMenuOpenChange?.(true);
              }
            }}
          >
            <MessagesSquareIcon className="mr-2 size-4" />
            Send to chat
            {targets.length === 1 ? (
              <Badge
                variant="secondary"
                className="ml-auto shrink-0 px-1.5 py-0 text-[10px]"
              >
                {targets[0].location}
              </Badge>
            ) : (
              <ChevronRightIcon className="ml-auto size-3.5" />
            )}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {(window.catalex || (import.meta.env.DEV && browserHarness())) && (
        <ContextMenuItem
          disabled={!projectRoot}
          onSelect={() =>
            openPanelWindow("editor", aiEnabled ? "duet" : "artisan", {
              fileId: file.id,
            })
          }
        >
          <AppWindowIcon className="mr-2 size-4" />
          Open in pop-out
        </ContextMenuItem>
      )}
      <ContextMenuItem
        onClick={() => {
          void navigator.clipboard
            .writeText(file.absolutePath)
            .catch((error) => reportFailure("Could not copy file path", error));
        }}
      >
        <CopyIcon className="mr-2 size-4" />
        Copy file path
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!projectRoot}
        onClick={() => {
          if (!projectRoot) return;
          void invoke("open_in_editor", {
            editorId: "finder",
            projectPath: projectRoot,
            filePath: file.relativePath,
          }).catch((error) =>
            reportFailure("Could not open file location", error),
          );
        }}
      >
        <FolderOpenIcon className="mr-2 size-4" />
        {navigator.platform.startsWith("Mac")
          ? "Open in Finder"
          : "Open in file manager"}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {children}
    </>
  );
}
