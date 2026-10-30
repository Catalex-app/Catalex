import { useEffect, useState } from "react";
import {
  COMMENT_SAVE_PROGRESS_EVENT,
  getUnsavedCommentFiles,
} from "@/components/workspace/editor/inline-comment-storage";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function CommentCloseDialog({
  open,
  busy,
  waiting = false,
  projectRoot,
  files,
  onCancel,
  onRetry,
  onDiscard,
}: {
  open: boolean;
  busy: boolean;
  waiting?: boolean;
  projectRoot?: string | null;
  files?: string[];
  onCancel: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const [pendingFiles, setPendingFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!open || !projectRoot) {
      setPendingFiles([]);
      return;
    }
    const update = () => setPendingFiles(getUnsavedCommentFiles(projectRoot));
    update();
    window.addEventListener(COMMENT_SAVE_PROGRESS_EVENT, update);
    return () =>
      window.removeEventListener(COMMENT_SAVE_PROGRESS_EVENT, update);
  }, [open, projectRoot]);
  const affectedFiles = files ?? pendingFiles;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="text-left">
          <DialogTitle>
            {waiting
              ? "Comments are taking longer to save"
              : "Comments couldn’t be saved"}
          </DialogTitle>
          <DialogDescription>
            {affectedFiles.length
              ? "These files have unsaved comment changes:"
              : "Comment changes have not finished saving."}
          </DialogDescription>
        </DialogHeader>
        {affectedFiles.length > 0 && (
          <ul
            aria-label="Files with unsaved comments"
            className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"
          >
            {affectedFiles.map((file) => (
              <li key={file} className="break-words py-1">
                {file}
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-3 gap-2 [&>button]:min-w-0 [&>button]:px-2">
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onDiscard}>
            Close anyway
          </Button>
          <Button disabled={busy} onClick={onRetry}>
            {busy ? "Saving…" : waiting ? "Keep waiting" : "Retry saving"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
