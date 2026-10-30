import { Hint } from "@/components/ui/tooltip";
import { BookmarkPlusIcon, HistoryIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { useDocumentStore } from "@/stores/document-store";
import { useHistoryStore, type SnapshotInfo } from "@/stores/history-store";
import { useHistoryWorkspaceStore } from "@/stores/history-workspace-store";
import {
  labelValidationReason,
  snapshotLabelOptions,
} from "./history-workspace-model";

export function WorkspaceHistoryControl() {
  const setOpen = useHistoryWorkspaceStore((state) => state.setOpen);
  const projectRoot = useDocumentStore((state) => state.projectRoot);
  const blocked = useDocumentStore(
    (state) =>
      !state.projectRoot ||
      state.isGitOperationRunning ||
      state.isApplyingAgentDraft ||
      !!state.agentWorkspaceRoot ||
      state.isAgentWorkspaceReadOnly,
  );
  const restoring = useHistoryStore((state) => state.isRestoring);
  const clearing = useHistoryStore((state) => state.isHistoryClearing);
  const labelCounts = useHistoryStore((state) => state.labelCounts);
  const [open, setSaveOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep a successfully saved checkpoint when only its label needs retrying.
  const [saved, setSaved] = useState<SnapshotInfo | null>(null);
  const busy = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const openedFor = useRef<string | null>(null);
  const invalid = label.trim() ? labelValidationReason(label) : null;

  useEffect(() => {
    setSaveOpen(false);
    setLabel("");
    setSaved(null);
    setError(null);
  }, [projectRoot]);

  const save = async () => {
    if (!projectRoot || busy.current || invalid) return;
    const document = useDocumentStore.getState();
    const history = useHistoryStore.getState();
    if (
      document.projectRoot !== projectRoot ||
      document.isGitOperationRunning ||
      document.isApplyingAgentDraft ||
      document.agentWorkspaceRoot ||
      document.isAgentWorkspaceReadOnly ||
      history.isRestoring ||
      history.isHistoryClearing
    )
      return;
    const ownsProject = () =>
      useDocumentStore.getState().projectRoot === projectRoot;
    busy.current = true;
    setSaving(true);
    setError(null);
    let target = saved;
    try {
      if (!target) {
        // Match Cmd+S: persist the active file, then checkpoint the project.
        await document.saveFile(document.activeFileId);
        if (!ownsProject()) return;
        target = await history.createSnapshot(projectRoot, "[manual] Save");
        if (!ownsProject()) return;
        if (!target) {
          // Unchanged files reuse the latest version, never create an empty commit.
          await history.loadSnapshots(projectRoot);
          if (!ownsProject()) return;
          target = useHistoryStore.getState().snapshots[0] ?? null;
        }
        if (!target)
          throw new Error(
            "No saved checkpoint is available. Please try again.",
          );
        setSaved(target);
      }
      const text = label.trim();
      if (text && !target.labels.includes(text)) {
        await history.addLabel(projectRoot, target.id, text);
      }
      if (!ownsProject()) return;
      setSaveOpen(false);
      toast.success(text ? "Checkpoint saved and labeled" : "Checkpoint saved");
    } catch (cause) {
      if (ownsProject())
        setError(
          target
            ? `Checkpoint saved, but the label could not be saved. ${String(cause)}`
            : `Could not save checkpoint. ${String(cause)}`,
        );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <ButtonGroup
      variant="plain"
      aria-label="Project history"
      className="workspace-history-group flex shrink-0 items-center"
    >
      <Hint content="Save checkpoint">
        <Button
          ref={trigger}
          variant="ghost"
          size="icon"
          className="workspace-history-control size-8 shrink-0 rounded-lg border border-border/70 bg-muted/50 text-muted-foreground hover:text-foreground"
          aria-label="Save checkpoint"
          disabled={blocked || restoring || clearing || saving}
          onClick={() => {
            openedFor.current = projectRoot;
            setLabel("");
            setSaved(null);
            setError(null);
            setSaveOpen(true);
            void useHistoryStore
              .getState()
              .loadLabelCounts(projectRoot!)
              .catch(() => {});
          }}
        >
          <BookmarkPlusIcon className="size-4" />
        </Button>
      </Hint>
      <span
        aria-hidden="true"
        className="button-group-separator workspace-history-separator"
      />
      <Hint content="Rewind">
        <Button
          variant="ghost"
          size="icon"
          className="workspace-history-control workspace-history-rewind-control h-8 w-auto shrink-0 gap-1 rounded-lg border border-border/70 bg-muted/50 px-2 text-muted-foreground text-xs hover:text-foreground"
          aria-label="Rewind"
          onClick={() => setOpen(true)}
        >
          <HistoryIcon className="size-4" />
          <span className="workspace-history-rewind-label">Rewind</span>
        </Button>
      </Hint>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy.current) setSaveOpen(next);
        }}
      >
        <DialogContent
          showCloseButton={!saving}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (openedFor.current === useDocumentStore.getState().projectRoot)
              trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Save checkpoint</DialogTitle>
            <DialogDescription>
              Save a local version in Rewind. Add an optional label to find it
              later.
            </DialogDescription>
          </DialogHeader>
          <SearchablePicker
            hideWhenEmpty
            openOnFocus={false}
            disabled={saving}
            query={label}
            onQueryChange={setLabel}
            label="Snapshot label"
            placeholder="Label (optional)"
            options={snapshotLabelOptions(labelCounts, label)}
            onSelect={setLabel}
            onSubmit={() => void save()}
            emptyText="No existing labels"
          />
          {(error || invalid) && (
            <p role="alert" className="text-destructive text-sm">
              {error || invalid}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setSaveOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={saving || blocked || restoring || clearing || !!invalid}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : saved ? "Save label" : "Save checkpoint"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ButtonGroup>
  );
}
