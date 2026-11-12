import { Hint } from "@/components/ui/tooltip";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Link2Icon,
  Unlink2Icon,
} from "lucide-react";
import type { Ref } from "react";

export function SyncNavigationControl({
  ref,
  previewLabel,
  onNavigateToPreview,
  onNavigateToEditor,
  scrollSyncLocked = false,
  scrollSyncMuted = false,
  onScrollSyncEnabledChange,
}: {
  ref?: Ref<HTMLDivElement>;
  previewLabel: string;
  onNavigateToPreview: () => void;
  onNavigateToEditor: () => void;
  scrollSyncLocked?: boolean;
  scrollSyncMuted?: boolean;
  onScrollSyncEnabledChange: (enabled: boolean) => void;
}) {
  const linked = scrollSyncLocked && !scrollSyncMuted;
  const syncLabel = scrollSyncMuted
    ? "Synchronized scrolling unavailable for multi-file LaTeX document"
    : linked
      ? "Disable synchronized scrolling"
      : "Enable synchronized scrolling";
  const buttonClassName =
    "flex h-9 w-full cursor-default items-center justify-center rounded-[2px] transition-colors duration-200 motion-reduce:transition-none hover:bg-black hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-35 dark:hover:bg-white dark:hover:text-black";

  return (
    <>
      <div
        aria-hidden="true"
        data-testid="scroll-sync-bridge"
        className={`pointer-events-none absolute inset-y-0 -left-px z-10 w-[calc(100%+2px)] transition-opacity duration-200 ease-out motion-reduce:transition-none ${linked ? "opacity-100" : "opacity-0"}`}
      >
        <div className="absolute inset-x-0 inset-y-3 bg-border/25 dark:bg-card" />
        {(["top", "bottom"] as const).map((edge) => (
          <svg
            key={edge}
            viewBox="0 0 34 12"
            className={`absolute -left-3 h-3 w-[34px] fill-border/25 dark:fill-card ${edge === "top" ? "top-0" : "bottom-0 -scale-y-100"}`}
          >
            <path d="M0 0 C8 0 11 5 17 5 C23 5 26 0 34 0 C27.373 0 22 5.373 22 12 H12 C12 5.373 6.627 0 0 0 Z" />
          </svg>
        ))}
      </div>
      <div
        ref={ref}
        data-testid="sync-navigation-control"
        data-scroll-sync-linked={linked}
        className="pointer-events-auto absolute top-1/2 left-0 z-20 flex w-full -translate-y-1/2 cursor-default flex-col"
        onPointerDownCapture={(event) => event.stopPropagation()}
        onMouseDownCapture={(event) => event.stopPropagation()}
        onTouchStartCapture={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <div
          aria-hidden={linked}
          inert={linked}
          className={`overflow-hidden transition-[height,opacity] duration-200 ease-out motion-reduce:transition-none ${linked ? "h-0 opacity-0" : "h-10 opacity-100"}`}
        >
          <Hint content={`Locate ${previewLabel} position`}>
            <button
              type="button"
              aria-label={`Locate ${previewLabel} position`}
              className={`${buttonClassName} bg-muted/80 text-muted-foreground`}
              onClick={(event) => {
                event.stopPropagation();
                onNavigateToPreview();
              }}
            >
              <ChevronRightIcon className="size-2.5 stroke-[2.75]" />
            </button>
          </Hint>
        </div>
        <Hint content={syncLabel}>
          <button
            type="button"
            aria-label={syncLabel}
            aria-pressed={linked}
            disabled={scrollSyncMuted}
            data-scroll-sync-muted={scrollSyncMuted}
            className={`${buttonClassName} ${linked ? "bg-background/80 text-primary dark:bg-primary/15" : "bg-muted/80 text-muted-foreground"}`}
            onClick={(event) => {
              event.stopPropagation();
              onScrollSyncEnabledChange(!linked);
            }}
          >
            {linked ? (
              <Link2Icon className="size-2.5 shrink-0 rotate-90 stroke-[2.5]" />
            ) : (
              <Unlink2Icon className="size-2.5 shrink-0 rotate-90 stroke-[2.5]" />
            )}
          </button>
        </Hint>
        <div
          aria-hidden={linked}
          inert={linked}
          className={`overflow-hidden transition-[height,opacity] duration-200 ease-out motion-reduce:transition-none ${linked ? "h-0 opacity-0" : "h-10 opacity-100"}`}
        >
          <div className="h-1" />
          <Hint content="Locate editor position">
            <button
              type="button"
              aria-label="Locate editor position"
              className={`${buttonClassName} bg-muted/80 text-muted-foreground`}
              onClick={(event) => {
                event.stopPropagation();
                onNavigateToEditor();
              }}
            >
              <ChevronLeftIcon className="size-2.5 stroke-[2.75]" />
            </button>
          </Hint>
        </div>
      </div>
    </>
  );
}
