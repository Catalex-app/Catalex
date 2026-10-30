import { useEffect, useState } from "react";
import { ListChecksIcon, MessageSquareTextIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useDocumentStore } from "@/stores/document-store";
import { OPEN_COMMENT_MANAGER_EVENT } from "@/lib/workspace-events";
import { SidebarRow, SidebarRowIcon } from "../sidebar-layout";
import { CommentFileManager } from "./comment-file-manager";
import { useProjectComments } from "./use-project-comments";

export function CommentDeleteButtons() {
  const root = useDocumentStore((state) => state.projectRoot);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [files, , , loaded, , disconnected] = useProjectComments(
    open ? root : null,
    undefined,
    true,
  );
  useEffect(() => {
    setOpen(false);
  }, [root]);
  useEffect(() => {
    const requestOpen = (event: Event) => {
      const { projectRoot } = (event as CustomEvent<{ projectRoot: string }>)
        .detail;
      if (root && projectRoot === root && !busy) setOpen(true);
    };
    window.addEventListener(OPEN_COMMENT_MANAGER_EVENT, requestOpen);
    return () =>
      window.removeEventListener(OPEN_COMMENT_MANAGER_EVENT, requestOpen);
  }, [root, busy]);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) setOpen(value);
      }}
    >
      <SidebarRow asChild>
        <div data-comment-clear-row>
          <SidebarRowIcon className="text-foreground">
            <ListChecksIcon className="size-4" />
          </SidebarRowIcon>
          <span className="min-w-0 flex-1 truncate text-xs">
            Manage comments
          </span>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className="h-5 px-1.5 text-[10px]"
              disabled={!root || busy}
            >
              Manage
            </Button>
          </DialogTrigger>
        </div>
      </SidebarRow>
      <DialogContent
        size="wide"
        aria-describedby={undefined}
        className="flex max-h-[90vh] flex-col overflow-hidden rounded-[20px] bg-muted p-4 shadow-2xl dark:bg-background"
        overlayClassName="bg-black/10"
        showCloseButton={false}
      >
        <DialogHeader className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="inline-flex items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 py-1.5 dark:bg-muted">
              <MessageSquareTextIcon className="size-5 text-muted-foreground" />
              <span className="font-medium text-sm">Comments</span>
            </div>
            <Button
              aria-label="Close"
              variant="outline"
              size="icon-sm"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              <XIcon className="size-4" />
            </Button>
          </div>
          <DialogTitle>Manage comments</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {root && (
            <CommentFileManager
              key={root}
              root={root}
              files={files}
              groups={disconnected}
              disabled={!loaded}
              onBusyChange={setBusy}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
