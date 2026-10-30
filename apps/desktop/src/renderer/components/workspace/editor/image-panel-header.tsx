import { Hint } from "@/components/ui/tooltip";
import { type ReactNode } from "react";
import { WorkspacePanelHeader } from "../workspace-panel";
import { FilePanelHeader } from "./file-panel-header";
import { type ImageFitMode } from "./use-image-zoom";
import { CropIcon, MinusIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ZOOM_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function ImagePanelHeader({
  scale,
  onScaleChange,
  fileSize,
  cropMode = false,
  onCropToggle,
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
  cropMode?: boolean;
  onCropToggle?: () => void;
  fitMode?: ImageFitMode;
  onFitModeChange?: (mode: ImageFitMode) => void;
}) {
  const controls = (
    <>
      <Hint content="Zoom out">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Zoom out"
          disabled={!onScaleChange || cropMode || scale <= 0.25}
          onClick={() => onScaleChange?.(Math.max(0.25, scale - 0.25))}
        >
          <MinusIcon className="size-3.5" />
        </Button>
      </Hint>
      <Hint content="Zoom in">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Zoom in"
          disabled={!onScaleChange || cropMode || scale >= 4}
          onClick={() => onScaleChange?.(Math.min(4, scale + 0.25))}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </Hint>
      <Select
        value={fitMode ?? String(scale)}
        onValueChange={(value) => {
          if (value === "fit-width" || value === "fit-height")
            onFitModeChange?.(value);
          else onScaleChange?.(Number(value));
        }}
        disabled={!onScaleChange || cropMode}
      >
        <SelectTrigger
          aria-label="Image zoom"
          size="sm"
          className="h-7! w-auto text-xs"
        >
          <SelectValue>
            {fitMode === "fit-width"
              ? "Width"
              : fitMode === "fit-height"
                ? "Height"
                : `${Math.round(scale * 100)}%`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          {onFitModeChange && (
            <>
              <SelectItem value="fit-width">Fit to width</SelectItem>
              <SelectItem value="fit-height">Fit to height</SelectItem>
              <SelectSeparator />
            </>
          )}
          {ZOOM_OPTIONS.map((value) => (
            <SelectItem key={value} value={String(value)}>
              {value * 100}%
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {onCropToggle && (
        <>
          <div className="mx-1 h-4 w-px bg-border" />
          <Button
            variant={cropMode ? "default" : "ghost"}
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            aria-pressed={cropMode}
            onClick={onCropToggle}
          >
            <CropIcon className="size-3.5" />
            Crop
          </Button>
        </>
      )}
      {actions}
    </>
  );
  return toolbarContent ? (
    <WorkspacePanelHeader
      as="header"
      role="toolbar"
      aria-label="Image controls"
      className="h-auto min-h-12 flex-wrap gap-x-2 gap-y-1 py-1.5"
    >
      <div className="min-w-[180px] flex-1">{toolbarContent}</div>
      <div className="ml-auto flex shrink-0 items-center gap-1">{controls}</div>
    </WorkspacePanelHeader>
  ) : (
    <FilePanelHeader label="Image controls" fileSize={fileSize}>
      {controls}
    </FilePanelHeader>
  );
}
