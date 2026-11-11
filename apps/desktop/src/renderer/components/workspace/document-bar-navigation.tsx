import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  documentCounterClassName,
  documentStepButtonClassName,
} from "./document-navigation-styles";

export function DocumentBarNavigation({
  label,
  previousLabel,
  nextLabel,
  itemLabel,
  current,
  total,
  onPrevious,
  onNext,
}: {
  label: string;
  previousLabel: string;
  nextLabel: string;
  itemLabel: string;
  current: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const disabled = total === 0;
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center">
      <Hint content={previousLabel}>
        <Button
          variant="ghost"
          size="icon"
          className={documentStepButtonClassName}
          onClick={onPrevious}
          disabled={disabled}
          aria-label={previousLabel}
        >
          <ChevronUp className="size-3.5" />
        </Button>
      </Hint>
      <span
        className={cn(
          documentCounterClassName,
          "text-muted-foreground",
          disabled && "opacity-50",
        )}
        role="status"
        aria-label={`${itemLabel} ${current} of ${total}`}
      >
        <span>{current}</span>
        <span>/</span>
        <span>{total}</span>
      </span>
      <Hint content={nextLabel}>
        <Button
          variant="ghost"
          size="icon"
          className={documentStepButtonClassName}
          onClick={onNext}
          disabled={disabled}
          aria-label={nextLabel}
        >
          <ChevronDown className="size-3.5" />
        </Button>
      </Hint>
    </div>
  );
}
