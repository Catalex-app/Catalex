import { type ReactNode } from "react";
import { DocumentZoomControl } from "../document-zoom-control";
import { WorkspacePanelHeader } from "../workspace-panel";
import { FilePanelHeader } from "./file-panel-header";
import {
  type ImageFitMode,
  MIN_IMAGE_SCALE,
  MAX_IMAGE_SCALE,
} from "./use-image-zoom";

export function ImagePanelHeader({
  scale,
  onScaleChange,
  fileSize,
  fitMode = null,
  onFitModeChange,
  actions,
  toolbarContent,
}: {
  actions?: ReactNode;
  toolbarContent?: ReactNode;
  scale: number;
  onScaleChange?: (scale: number) => void;
  fileSize?: number;
  fitMode?: ImageFitMode;
  onFitModeChange?: (mode: ImageFitMode) => void;
}) {
  const controls = (
    <>
      <DocumentZoomControl
        label="Image zoom"
        scale={scale}
        minScale={MIN_IMAGE_SCALE}
        maxScale={MAX_IMAGE_SCALE}
        fitMode={fitMode}
        onFitModeChange={onFitModeChange}
        onChange={onScaleChange}
        zoomIn={() => onScaleChange?.(Math.min(MAX_IMAGE_SCALE, scale + 0.25))}
        zoomOut={() => onScaleChange?.(Math.max(MIN_IMAGE_SCALE, scale - 0.25))}
      />
      {actions}
    </>
  );
  return toolbarContent ? (
    <WorkspacePanelHeader
      hasTrailingContent
      trailingContent={
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
          {controls}
        </div>
      }
      as="header"
      role="toolbar"
      aria-label="Image controls"
      className="h-auto min-h-12 flex-wrap gap-x-2 gap-y-1 py-1.5 [&>[data-panel-header-trailing]]:min-w-0 [&>[data-panel-header-trailing]]:max-w-full"
    >
      <div className="min-w-[180px] flex-1">{toolbarContent}</div>
    </WorkspacePanelHeader>
  ) : (
    <FilePanelHeader label="Image controls" fileSize={fileSize} wrapControls>
      {controls}
    </FilePanelHeader>
  );
}
