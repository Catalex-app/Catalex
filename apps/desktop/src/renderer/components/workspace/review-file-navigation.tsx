import type { CSSProperties } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { ButtonGroup } from "@/components/ui/button-group";
import { Hint } from "@/components/ui/tooltip";

export interface ReviewFileNavigationProps {
  currentIndex: number;
  totalFiles: number;
  onPrevious: () => void;
  onNext: () => void;
}

interface ReviewFileNavigationAppearance {
  labels: {
    title: string;
    group: string;
    pending: string;
    previous: string;
    previousHint: string;
    next: string;
    nextHint: string;
  };
  colors: {
    light: string;
    dark: string;
    hoverForeground: string;
  };
}

/** Shared geometry and interactions; each review flow owns its text and palette. */
export function ReviewFileNavigation({
  currentIndex,
  totalFiles,
  onPrevious,
  onNext,
  labels,
  colors,
}: ReviewFileNavigationProps & ReviewFileNavigationAppearance) {
  const counterLabel = `${
    currentIndex < 0 ? totalFiles : `${currentIndex + 1} of ${totalFiles}`
  } ${labels.pending}`;
  const disabled = totalFiles === 1 && currentIndex === 0;
  const buttonClassName =
    "flex h-full w-5 items-center justify-center outline-none transition-colors hover:bg-[var(--review-navigation-color)] hover:text-[color:var(--review-navigation-hover-foreground)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-40";

  return (
    <ButtonGroup
      variant="plain"
      aria-label={labels.group}
      data-review-file-navigation
      className="flex h-8 shrink-0 items-center gap-1 overflow-hidden rounded-md border border-[var(--review-navigation-color)] bg-transparent p-0 text-[color:var(--review-navigation-color)] [--review-navigation-color:var(--review-navigation-light)] dark:[--review-navigation-color:var(--review-navigation-dark)]"
      style={
        {
          "--review-navigation-light": colors.light,
          "--review-navigation-dark": colors.dark,
          "--review-navigation-hover-foreground": colors.hoverForeground,
        } as CSSProperties
      }
    >
      <Hint content={labels.previousHint}>
        <button
          type="button"
          aria-label={labels.previous}
          disabled={disabled}
          onClick={onPrevious}
          className={buttonClassName}
        >
          <ChevronLeftIcon className="size-3" />
        </button>
      </Hint>
      <Hint content={counterLabel}>
        <span
          role="status"
          aria-label={counterLabel}
          aria-live="polite"
          aria-atomic="true"
          className="flex items-center gap-1 font-semibold text-xs"
        >
          <span>{labels.title}</span>
          <span className="min-w-6 text-center tabular-nums">
            {currentIndex < 0
              ? `${totalFiles} left`
              : `${currentIndex + 1}/${totalFiles}`}
          </span>
        </span>
      </Hint>
      <Hint content={labels.nextHint}>
        <button
          type="button"
          aria-label={labels.next}
          disabled={disabled}
          onClick={onNext}
          className={buttonClassName}
        >
          <ChevronRightIcon className="size-3" />
        </button>
      </Hint>
    </ButtonGroup>
  );
}
