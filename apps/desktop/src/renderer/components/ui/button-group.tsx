import type { ComponentProps, ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Hint } from "./tooltip";
import "./button-group.css";

type ButtonGroupSelection<Value extends string> = {
  layout?: "normal" | "compact" | "responsive";
  compactLabel: string;
  compactIconsOnly?: boolean;
  value: Value;
  onValueChange: (value: Value) => void;
  options: readonly {
    value: Value;
    label: string;
    shortLabel?: string;
    icon?: ReactNode;
    count?: number;
    hint?: string;
  }[];
};

/**
 * A selection can switch between segments and a menu. The responsive layout
 * uses the nearest size container, switching to segments at 460px.
 * Custom children can supply their own aria-selected/aria-pressed state or
 * data-button-group-item + data-active for composite tabs.
 */
function ButtonGroup<Value extends string>({
  className,
  variant = "default",
  selection,
  children,
  ...props
}: ComponentProps<"div"> & {
  variant?: "default" | "plain";
  selection?: ButtonGroupSelection<Value>;
}) {
  const layout = selection?.layout ?? "normal";
  const normal = (
    <div
      role="group"
      data-slot="button-group"
      className={cn(
        variant === "default" && "segmented-control rounded-lg bg-muted/50 p-1",
        selection && "flex h-8 shrink-0 items-center text-xs",
        className,
      )}
      {...props}
    >
      {selection
        ? selection.options.map((option) => {
            const selected = option.value === selection.value;
            const button = (
              <button
                key={option.value}
                type="button"
                aria-label={option.label}
                aria-pressed={selected}
                onClick={() => selection.onValueChange(option.value)}
                className={cn(
                  "flex h-6 items-center justify-center gap-1 rounded-md px-2 font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                )}
              >
                {option.shortLabel ?? option.icon ?? option.label}
                {option.count !== undefined && <span>{option.count}</span>}
              </button>
            );
            return option.hint ? (
              <Hint key={option.value} content={option.hint}>
                {button}
              </Hint>
            ) : (
              button
            );
          })
        : children}
    </div>
  );

  if (!selection || layout === "normal") return normal;

  const selected = selection.options.find(
    (option) => option.value === selection.value,
  );
  const selectedLabel =
    selected?.count === undefined
      ? selected?.label
      : `${selected.label} (${selected.count})`;
  const compact = (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={
          selectedLabel
            ? `${selection.compactLabel}: ${selectedLabel}`
            : selection.compactLabel
        }
        className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background px-2 font-medium text-foreground text-xs tabular-nums shadow-sm transition-colors hover:bg-background/90 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {selected?.icon}
        {(!selected?.icon ||
          (!selection.compactIconsOnly && selected.count === undefined)) &&
          (selected?.shortLabel ?? selected?.label ?? selection.compactLabel)}
        {selected?.count}
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={selection.value}>
          {selection.options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              indicator={<CheckIcon className="size-4" />}
              indicatorPosition="end"
              onSelect={() => selection.onValueChange(option.value)}
            >
              {option.icon}
              {option.label}
              {option.count !== undefined && ` (${option.count})`}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return layout === "compact" ? (
    compact
  ) : (
    <div className="responsive-button-group flex shrink-0 items-center">
      <div data-button-group-layout="normal">{normal}</div>
      <div data-button-group-layout="compact">{compact}</div>
    </div>
  );
}

export { ButtonGroup };
