import { Hint } from "@/components/ui/tooltip";
import { useEffect, useMemo, useState } from "react";
import { FileTextIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { invoke } from "@/lib/desktop/core";
import { getFileType } from "@/lib/project-files";
import { readFile } from "@/lib/desktop/fs";
import type { ProjectFile } from "@/stores/document-store";
import { ImagePreview } from "./editor/image-preview";
import { PdfPreview } from "./preview/pdf-preview";
import { WorkspacePanelHeader } from "./workspace-panel";

function CurrentAssetMetadata({ file }: { file: ProjectFile }) {
  return (
    <div className="min-w-0 text-xs leading-4">
      <Hint content={file.relativePath}>
        <div className="truncate font-medium">{file.name}</div>
      </Hint>
      <div className="text-[10px] text-muted-foreground">
        Current project asset · Not a historical preview.
      </div>
    </div>
  );
}

/** Display current media without switching the live editor or modifying files. */
export function HistoryMediaContent({ file }: { file: ProjectFile }) {
  const [scale, setScale] = useState(1);
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-testid="history-media-content"
      data-media-type={file.type}
    >
      {file.type === "image" ? (
        <ImagePreview
          file={file}
          scale={scale}
          onScaleChange={setScale}
          readOnly
          toolbarContent={<CurrentAssetMetadata file={file} />}
        />
      ) : (
        <CurrentPdfAsset file={file} />
      )}
    </div>
  );
}

function CurrentPdfAsset({ file }: { file: ProjectFile }) {
  const fileKey = JSON.stringify([file.absolutePath, file.diskModifiedAt]);
  const [result, setResult] = useState<{
    key: string;
    bytes: Uint8Array;
  } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null,
  );
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let canceled = false;
    setError(null);
    setResult(null);
    void readFile(file.absolutePath)
      .then((bytes) => {
        if (canceled) return;
        if (!bytes.byteLength) throw new Error("The PDF file is empty.");
        setResult({ key: fileKey, bytes });
      })
      .catch((cause) => {
        if (!canceled)
          setError({
            key: fileKey,
            message: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => {
      canceled = true;
    };
  }, [file.absolutePath, fileKey, retry]);

  const bytes = result?.key === fileKey ? result.bytes : null;
  const currentError = error?.key === fileKey ? error.message : null;
  const metadata = <CurrentAssetMetadata file={file} />;
  if (bytes) {
    return (
      <PdfPreview
        key={fileKey}
        standalonePdfData={bytes}
        standaloneRootFileId={`current-asset:${file.absolutePath}`}
        isolatedSnapshot
        aiEnabled={false}
        editorVisible={false}
        toolbarContent={metadata}
      />
    );
  }
  return (
    <>
      <WorkspacePanelHeader className="h-auto min-h-12 py-1.5">
        {metadata}
      </WorkspacePanelHeader>
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-muted/30 p-6 text-center"
        role={currentError ? "alert" : "status"}
      >
        {currentError ? (
          <>
            <FileTextIcon className="size-6 text-muted-foreground" />
            <p className="text-sm">Could not load this PDF</p>
            <p className="max-w-md break-words text-muted-foreground text-xs">
              {currentError}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry PDF
            </Button>
          </>
        ) : (
          <>
            <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
            <p className="text-muted-foreground text-sm">Loading PDF…</p>
          </>
        )}
      </div>
    </>
  );
}

/** Decode saved media in memory; never replace it with today's file. */
export function HistoryRecordedAsset({
  projectRoot,
  snapshotId,
  path,
}: {
  projectRoot: string;
  snapshotId: string;
  path: string;
}) {
  const [result, setResult] = useState<{ key: string; base64: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([projectRoot, snapshotId, path]);
  const type = getFileType(path);
  useEffect(() => {
    let canceled = false;
    setResult(null);
    setError(null);
    if (type !== "image" && type !== "pdf") return;
    void invoke<string>("history_file_bytes", {
      projectRoot,
      snapshotId,
      filePath: path,
    })
      .then((base64) => {
        if (!canceled) setResult({ key, base64 });
      })
      .catch(() => {
        if (!canceled) setError("Could not load this saved asset.");
      });
    return () => {
      canceled = true;
    };
  }, [projectRoot, snapshotId, path, key, type, retry]);
  const metadata = (
    <div className="min-w-0 text-xs leading-4">
      <Hint content={path}>
        <div className="truncate font-medium">{path.split("/").pop()}</div>
      </Hint>
      <div className="text-[10px] text-muted-foreground">
        Saved project asset · Read-only
      </div>
    </div>
  );
  const base64 = result?.key === key ? result.base64 : null;
  const pdfBytes = useMemo(
    () =>
      base64 !== null && type === "pdf"
        ? Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
        : undefined,
    [base64, type],
  );
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const mime: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    webp: "image/webp",
  };
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-testid="history-recorded-asset"
    >
      {base64 !== null && type === "image" ? (
        <ImagePreview
          file={{
            id: key,
            name: path.split("/").pop() ?? path,
            relativePath: path,
            absolutePath: "",
            type: "image",
            isDirty: false,
            dataUrl: `data:${mime[extension] ?? "application/octet-stream"};base64,${base64}`,
          }}
          scale={scale}
          onScaleChange={setScale}
          readOnly
          toolbarContent={metadata}
        />
      ) : base64 !== null && type === "pdf" ? (
        <PdfPreview
          standalonePdfData={pdfBytes}
          standaloneRootFileId={`snapshot-asset:${key}`}
          isolatedSnapshot
          aiEnabled={false}
          editorVisible={false}
          toolbarContent={metadata}
        />
      ) : (
        <>
          <WorkspacePanelHeader className="h-auto min-h-12 py-1.5">
            {metadata}
          </WorkspacePanelHeader>
          <div className="history-empty" role={error ? "alert" : "status"}>
            {type !== "image" && type !== "pdf" ? (
              <p>
                This file is saved in this snapshot and will be restored with
                the project. Preview is unavailable.
              </p>
            ) : error ? (
              <>
                <p>{error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Retry preview
                </Button>
              </>
            ) : (
              <>
                <LoaderCircleIcon className="size-5 animate-spin motion-reduce:animate-none" />
                <p>Loading saved asset…</p>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
