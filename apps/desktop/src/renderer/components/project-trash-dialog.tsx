import { useState } from "react";
import { Trash2Icon } from "lucide-react";
import { invoke } from "@/lib/desktop/core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ProjectTrashDialog({
  project,
  onClose,
  onTrashed,
}: {
  project: { name: string; path: string } | null;
  onClose: () => void;
  onTrashed: (path: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (!busy) {
      setError(null);
      onClose();
    }
  };
  const trash = async () => {
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("desktop:project:trash", { path: project.path });
      onTrashed(project.path);
      onClose();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!project}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2">
            <Trash2Icon className="size-5 shrink-0" />
            Move project to Trash?
          </DialogTitle>
          <DialogDescription>
            The project folder and all its files will be moved to your system
            Trash.
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 rounded-lg bg-muted p-3">
          <p className="break-words font-medium text-sm">{project?.name}</p>
          <p className="break-all text-muted-foreground text-xs">
            {project?.path}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close} autoFocus>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() => void trash()}
          >
            {busy ? "Moving…" : "Move to Trash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
