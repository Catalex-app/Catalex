import type { ReactNode } from "react";
import { CheckIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Shared action rows for workspace dialogs, including Git commit. */
export function ActionSelector<T extends string>({
  value,
  onChange,
  options,
  disabled = false,
}: {
  value: T;
  onChange: (value: T) => void;
  options: {
    value: T;
    label: string;
    icon: LucideIcon;
    destructive?: boolean;
    disabled?: boolean;
    accessory?: ReactNode;
    accessoryPosition?: "inline" | "below";
  }[];
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Action"
      className="overflow-hidden rounded-xl border border-border/70 bg-background dark:bg-muted"
    >
      {options.map((option, index) => (
        <div
          key={option.value}
          className={cn(
            option.accessoryPosition === "below"
              ? "flex flex-col"
              : "flex items-center",
            index < options.length - 1 && "border-sidebar-border border-b",
          )}
        >
          <button
            type="button"
            disabled={disabled || option.disabled}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex w-full items-center justify-between py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35 disabled:opacity-50",
              option.destructive && "text-destructive",
            )}
          >
            <span className="inline-flex items-center gap-2">
              <option.icon
                className={cn(
                  "size-3.5",
                  !option.destructive && "text-muted-foreground",
                )}
              />
              <span>{option.label}</span>
            </span>
            {value === option.value &&
            (!option.accessory || option.accessoryPosition === "below") ? (
              <CheckIcon className="size-4 shrink-0" />
            ) : null}
          </button>
          {option.accessory}
          {value === option.value &&
            option.accessory &&
            option.accessoryPosition !== "below" && (
              <span
                aria-hidden="true"
                className={cn(
                  "shrink-0 pr-3",
                  option.destructive && "text-destructive",
                  (disabled || option.disabled) && "opacity-50",
                )}
              >
                <CheckIcon className="size-4" />
              </span>
            )}
        </div>
      ))}
    </div>
  );
}
