import { CopyIcon, FolderOpenIcon, MessageSquarePlusIcon } from "lucide-react";
import { toast } from "sonner";
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { invoke } from "@/lib/desktop/core";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";

/** Queue on the existing composer handoff so closed drawers keep the attachment. */
export function sendSidebarFileToChat(file: ProjectFile) {
  const chat = useAgentChatStore.getState();
  if (
    !chat.pendingAttachments.some(
      (context) => context.selectionKey === `file:${file.relativePath}`,
    )
  ) {
    chat.addPendingAttachment({
      label: `@${file.relativePath}`,
      filePath: file.relativePath,
      selectedText: file.content ?? "",
      selectionPinned: true,
      selectionKey: `file:${file.relativePath}`,
    });
  }
}

export function SidebarFileContextActions({
  file,
  aiEnabled,
}: {
  file: ProjectFile;
  aiEnabled: boolean;
}) {
  const projectRoot = useDocumentStore((state) => state.projectRoot);
  const activeFileId = useDocumentStore((state) => state.activeFileId);
  const reportFailure = (action: string, error: unknown) => {
    toast.error(
      `${action}: ${error instanceof Error ? error.message : String(error)}`,
    );
  };
  return (
    <>
      {aiEnabled && file.id !== activeFileId && (
        <>
          <ContextMenuItem onClick={() => sendSidebarFileToChat(file)}>
            <MessageSquarePlusIcon className="mr-2 size-4" />
            Send to chat
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
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
    </>
  );
}
