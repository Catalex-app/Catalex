import { type ReactNode, useRef, useState } from "react";
import { FileIcon, Trash2Icon } from "lucide-react";
import { FilePanelHeader } from "./file-panel-header";
import { ImagePanelHeader } from "./image-panel-header";
import { useImageZoom } from "./use-image-zoom";

/** Shared whole-file pane for Git conflicts and agent draft decisions. */
export function FileVersionPane({
  path,
  label,
  previewUrl,
  size,
  text = null,
  deleted = false,
  actions,
  children,
  emptyDescription = "Accept keeps the complete file.",
}: {
  path: string;
  label: string;
  previewUrl?: string | null;
  size?: number;
  text?: string | null;
  deleted?: boolean;
  actions: ReactNode;
  children?: ReactNode;
  emptyDescription?: string;
}) {
  return (
    <section
      aria-label={label}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card"
    >
      {previewUrl ? (
        <ConflictImagePreview
          key={previewUrl}
          src={previewUrl}
          alt={`${label} of ${path}`}
          fileSize={size}
          actions={actions}
        >
          {children}
        </ConflictImagePreview>
      ) : (
        <>
          <FilePanelHeader fileName={path} fileSize={size} deleted={deleted}>
            {actions}
          </FilePanelHeader>
          {children}
          <div className="min-h-0 flex-1 overflow-auto">
            {deleted ? (
              <div className="flex h-full min-h-32 flex-col items-center justify-center gap-3 p-4 text-center text-muted-foreground">
                <Trash2Icon className="size-8" />
                <p className="text-sm">Deleted in this version</p>
              </div>
            ) : text !== null ? (
              <pre className="min-h-full whitespace-pre-wrap break-words p-4 font-mono text-sm">
                {text || "Empty file"}
              </pre>
            ) : (
              <div className="flex h-full min-h-32 flex-col items-center justify-center gap-3 p-4 text-center text-muted-foreground">
                <FileIcon className="size-8" />
                <p className="text-sm">No preview available</p>
                <p className="text-xs">{emptyDescription}</p>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function ConflictImagePreview({
  src,
  alt,
  fileSize,
  children,
  actions,
}: {
  actions: ReactNode;
  src: string;
  alt: string;
  fileSize?: number;
  children?: ReactNode;
}) {
  const [scale, setScale] = useState(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const zoom = useImageZoom({
    viewportRef,
    imageRef,
    sourceKey: src,
    scale,
    onScaleChange: setScale,
    base: "contain",
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ImagePanelHeader
        scale={zoom.displayScale}
        onScaleChange={zoom.changeScale}
        fitMode={zoom.fitMode}
        onFitModeChange={zoom.changeFitMode}
        fileSize={fileSize}
        actions={actions}
      />
      {children}
      <div
        ref={viewportRef}
        className="app-scrollbar min-h-0 flex-1 overflow-auto bg-muted/50 p-4"
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: Math.max(zoom.width, zoom.viewportWidth),
            height: Math.max(zoom.height, zoom.viewportHeight),
            margin: "0 auto",
          }}
        >
          <img
            ref={imageRef}
            src={src}
            alt={alt}
            className="max-w-none object-contain"
            style={{
              width: zoom.width || "100%",
              height: zoom.height || "auto",
            }}
          />
        </div>
      </div>
    </div>
  );
}
