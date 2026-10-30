import { type ReactNode, useEffect, useRef, useState } from "react";
import { getAssetUrl } from "@/lib/project-files";
import { stat } from "@/lib/desktop/fs";
import { type ProjectFile } from "@/stores/document-store";
import {
  type ProposedChange,
  useProposedChangesStore,
  settleFileReview,
} from "@/stores/proposed-changes-store";
import { FileVersionPane } from "./file-version-pane";

function AssetPane({
  file,
  label,
  actions,
}: {
  file: ProjectFile;
  label: string;
  actions: ReactNode;
}) {
  const [size, setSize] = useState<number>();
  useEffect(() => {
    let cancelled = false;
    setSize(undefined);
    void stat(file.absolutePath)
      .then((info) => {
        if (!cancelled) setSize(info.size);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [file.absolutePath]);
  return (
    <FileVersionPane
      path={file.relativePath}
      label={`${label} file`}
      previewUrl={file.type === "image" ? getAssetUrl(file.absolutePath) : null}
      size={size}
      actions={actions}
      emptyDescription="Accept or reject the complete file."
    />
  );
}

/** Whole-file decisions use the same atomic draft transaction as text edits. */
export function AgentFileReview({
  file,
  change,
  children,
}: {
  file: ProjectFile | null;
  change: ProposedChange | null;
  children: (panes: { current: ReactNode; incoming: ReactNode }) => ReactNode;
}) {
  const review = useProposedChangesStore((s) => s.workspaceReview);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retainedIncoming = useRef<ReactNode>(null);
  useEffect(() => {
    setError(null);
  }, [change?.id]);
  const deleted = change?.workspaceChangeKind === "deleted";
  const added = change?.workspaceChangeKind === "added";
  const decide = async (accept: boolean) => {
    if (!change || !file || pending || review?.isApplying) return;
    setPending(true);
    setError(null);
    try {
      await settleFileReview(change.id, accept);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    if (!change || pending || review?.isApplying) return;
    const handle = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.repeat
      )
        return;
      if (
        (event.target instanceof Element &&
          event.target.closest(
            'input, textarea, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]',
          )) ||
        document.querySelector('[role="dialog"], [role="alertdialog"]')
      )
        return;
      const key = event.key.toLowerCase();
      if (key !== "n" && key !== "y") return;
      event.preventDefault();
      event.stopPropagation();
      void decide(key === "y");
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [change, pending, review?.isApplying, decide]);
  const currentPath =
    change?.sourceAbsolutePath ??
    `${review?.session.projectRoot}/${change?.oldFilePath ?? change?.filePath}`;
  const asset = (path: string, relativePath: string): ProjectFile => ({
    ...file!,
    id: path,
    absolutePath: path,
    relativePath,
    name: relativePath.split("/").pop() ?? relativePath,
    dataUrl: undefined,
    content: undefined,
    isDirty: false,
  });
  const action = (accept: boolean) => (
    <button
      type="button"
      disabled={pending || review?.isApplying}
      onClick={() => void decide(accept)}
      className={`flex h-7 items-center gap-1 rounded-md px-2.5 font-medium text-white text-xs transition-colors disabled:cursor-wait disabled:opacity-60 ${accept ? "bg-[#36ad5e] hover:bg-[#2f9852]" : "bg-[#ef4444] hover:bg-[#dc3e3e]"}`}
      aria-label={
        accept
          ? deleted
            ? "Accept deletion"
            : "Accept"
          : deleted
            ? "Keep file"
            : "Reject"
      }
    >
      {accept
        ? deleted
          ? "Accept deletion"
          : "Accept"
        : deleted
          ? "Keep file"
          : "Reject"}
      <kbd className="ml-1 rounded bg-white/20 px-1 py-0.5 font-mono text-[10px]">
        {accept ? "⌘Y" : "⌘N"}
      </kbd>
    </button>
  );
  const current =
    !change || !file ? null : (
      <AssetPane
        key={`${change.id}:current`}
        file={asset(
          added ? change.absolutePath : currentPath,
          change.oldFilePath ?? change.filePath,
        )}
        label={added ? "Proposed" : deleted ? "To be deleted" : "Current"}
        actions={
          <>
            {action(false)}
            {(added || deleted) && action(true)}
          </>
        }
      />
    );
  const incoming =
    !change || !file || added || deleted ? null : (
      <AssetPane
        key={`${change.id}:incoming`}
        file={asset(change.absolutePath, change.newFilePath ?? change.filePath)}
        label="Proposed"
        actions={action(true)}
      />
    );
  if (incoming) retainedIncoming.current = incoming;
  return (
    <>
      {change && (error || review?.settlementError) && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
        >
          {error || review?.settlementError}
        </p>
      )}
      {children({
        current,
        incoming:
          incoming ??
          (retainedIncoming.current ? (
            <div aria-hidden className="pointer-events-none h-full">
              {retainedIncoming.current}
            </div>
          ) : null),
      })}
    </>
  );
}
