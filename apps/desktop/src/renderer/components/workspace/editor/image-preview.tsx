import {
  useImageZoom,
  MIN_IMAGE_SCALE,
  MAX_IMAGE_SCALE,
} from "./use-image-zoom";
import { ImagePanelHeader } from "./image-panel-header";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { type ProjectFile } from "@/stores/document-store";
import { LOCAL_ZOOM_SHORTCUTS_ATTR } from "@/lib/app-zoom";
import { getAssetUrl } from "@/lib/project-files";
import { Button } from "@/components/ui/button";

interface ImagePreviewProps {
  file: ProjectFile;
  scale: number;
  onScaleChange?: (scale: number) => void;
  toolbarContent?: ReactNode;
}

export function ImagePreview({
  file,
  scale: manualScale,
  onScaleChange: onManualScaleChange,
  toolbarContent,
}: ImagePreviewProps) {
  const [imageError, setImageError] = useState(false);
  const [imageRetry, setImageRetry] = useState(0);
  const imageSourceKey = `${file.id}:${imageRetry}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const {
    fitMode,
    changeFitMode,
    displayScale: scale,
    changeScale: onScaleChange,
    width,
  } = useImageZoom({
    viewportRef: containerRef,
    imageRef: imgRef,
    sourceKey: imageSourceKey,
    scale: manualScale,
    onScaleChange: onManualScaleChange,
  });

  useEffect(() => {
    setImageError(false);
  }, [imageSourceKey, file.dataUrl]);

  // Pinch-to-zoom (Cmd/Ctrl + wheel)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onScaleChange) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const delta = -e.deltaY * 0.001;
        onScaleChange(
          Math.max(MIN_IMAGE_SCALE, Math.min(MAX_IMAGE_SCALE, scale + delta)),
        );
      }
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [scale, onScaleChange]);

  // Keyboard zoom (Cmd/Ctrl +/-)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onScaleChange) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        onScaleChange(Math.min(MAX_IMAGE_SCALE, scale + 0.25));
      } else if (e.key === "-") {
        e.preventDefault();
        onScaleChange(Math.max(MIN_IMAGE_SCALE, scale - 0.25));
      } else if (e.key === "0") {
        e.preventDefault();
        onScaleChange(1);
      }
    };

    el.addEventListener("keydown", handleKeyDown);
    return () => el.removeEventListener("keydown", handleKeyDown);
  }, [scale, onScaleChange]);

  // Use dataUrl if available (in-memory), otherwise fall back to asset URL (large images)
  const imageSrc = file.dataUrl || getAssetUrl(file.absolutePath);
  const base64Offset = file.dataUrl?.indexOf(";base64,") ?? -1;
  const fileSize =
    file.dataUrl && base64Offset >= 0
      ? Math.floor(((file.dataUrl.length - base64Offset - 8) * 3) / 4) -
        (file.dataUrl.endsWith("==") ? 2 : file.dataUrl.endsWith("=") ? 1 : 0)
      : file.fileSize;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ImagePanelHeader
        toolbarContent={toolbarContent}
        scale={scale}
        fitMode={fitMode}
        onFitModeChange={changeFitMode}
        onScaleChange={onScaleChange}
        fileSize={fileSize}
      />
      <div
        ref={containerRef}
        tabIndex={-1}
        {...{ [LOCAL_ZOOM_SHORTCUTS_ATTR]: "true" }}
        className="app-scrollbar relative min-h-0 flex-1 overflow-auto bg-muted/50 p-4 outline-none"
        onMouseDownCapture={() => containerRef.current?.focus()}
      >
        <div
          className="relative"
          style={{ width: width || "100%", margin: "0 auto" }}
        >
          <img
            key={imageSourceKey}
            ref={imgRef}
            src={imageSrc}
            alt={file.name}
            style={{ width: "100%", height: "auto" }}
            draggable={false}
            onError={() => setImageError(true)}
            onLoad={() => setImageError(false)}
          />
        </div>
        {imageError && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted p-6 text-center"
            role="alert"
          >
            <p className="text-sm">Could not load this image</p>
            <p className="text-muted-foreground text-xs">
              The current project asset may have moved or become unavailable.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImageRetry((retry) => retry + 1)}
            >
              Retry image
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
