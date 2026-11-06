import { isComposingKey } from "@/lib/keyboard-events";
import { useRef, useState } from "react";
import {
  MinusIcon,
  PlusIcon,
  MoveHorizontalIcon,
  MoveVerticalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";

export function DocumentZoomControl({
  scale,
  label,
  minScale,
  maxScale,
  fitMode,
  onFitModeChange,
  hideFitWidth = false,
  hideFitHeight = false,
  onChange,
  zoomIn,
  zoomOut,
}: {
  scale: number;
  label: string;
  minScale: number;
  maxScale: number;
  fitMode?: "fit-width" | "fit-height" | null;
  onFitModeChange?: (mode: "fit-width" | "fit-height") => void;
  hideFitWidth?: boolean;
  hideFitHeight?: boolean;
  onChange?: (scale: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const commit = () => {
    const value = pending.current;
    pending.current = null;
    setDraft(null);
    if (value === null) return;
    const text = value.trim().replace(/%$/, "").trim();
    if (!/^\d+(\.\d+)?$/.test(text)) return;
    const percent = Number(text);
    if (Number.isFinite(percent))
      onChange?.(Math.max(minScale, Math.min(maxScale, percent / 100)));
  };
  const buttonClass =
    "flex h-full w-5 shrink-0 items-center justify-center hover:bg-muted disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  return (
    <>
      {onFitModeChange &&
        (["fit-width", "fit-height"] as const).map((mode) => {
          if (mode === "fit-width" ? hideFitWidth : hideFitHeight) return null;
          const title = mode === "fit-width" ? "Fit width" : "Fit height";
          const Icon =
            mode === "fit-width" ? MoveHorizontalIcon : MoveVerticalIcon;
          return (
            <Hint key={mode} content={title}>
              <Button
                variant="ghost"
                size="icon"
                className={`size-7 shrink-0 border ${fitMode === mode ? "border-input bg-background text-foreground hover:bg-background" : "border-transparent"}`}
                onClick={() => onFitModeChange(mode)}
                aria-label={title}
                aria-pressed={fitMode === mode}
              >
                <Icon className="size-3.5" />
              </Button>
            </Hint>
          );
        })}
      <div
        role="group"
        aria-label={label}
        className="flex h-7 w-[98px] shrink-0 items-center overflow-hidden rounded-md border border-input bg-background text-muted-foreground shadow-xs transition-colors has-[input:focus]:border-ring"
      >
        <Hint content="Zoom out">
          <button
            type="button"
            aria-label="Zoom out"
            className={buttonClass}
            disabled={!onChange || scale <= minScale}
            onClick={zoomOut}
          >
            <MinusIcon className="size-3.5" />
          </button>
        </Hint>
        <span
          aria-hidden="true"
          className="button-group-separator [--button-group-separator-inset:6px]"
        />
        <input
          aria-label="Zoom percentage"
          inputMode="decimal"
          disabled={!onChange}
          type="text"
          className="h-full min-w-0 flex-1 bg-transparent px-0.5 text-center text-foreground text-xs tabular-nums outline-none"
          value={draft ?? `${Math.round(scale * 100)}%`}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            pending.current = event.target.value;
            setDraft(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (isComposingKey(event) || event.defaultPrevented) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              commit();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              pending.current = null;
              setDraft(null);
              event.currentTarget.blur();
            }
          }}
        />
        <span
          aria-hidden="true"
          className="button-group-separator [--button-group-separator-inset:6px]"
        />
        <Hint content="Zoom in">
          <button
            type="button"
            aria-label="Zoom in"
            className={buttonClass}
            disabled={!onChange || scale >= maxScale}
            onClick={zoomIn}
          >
            <PlusIcon className="size-3.5" />
          </button>
        </Hint>
      </div>
    </>
  );
}
