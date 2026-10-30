import type { ComponentProps } from "react";
import { CheckIcon, MinusIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Visual indicator for selectable button rows; the row owns interaction. */
export function CheckboxIndicator({
  checked,
  mixed = false,
  className,
}: {
  checked: boolean;
  mixed?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors",
        checked || mixed
          ? "border-foreground bg-foreground text-background"
          : "border-muted-foreground/60 bg-background",
        className,
      )}
    >
      {mixed ? (
        <MinusIcon className="size-3" />
      ) : checked ? (
        <CheckIcon className="size-3" />
      ) : null}
    </span>
  );
}

/** Native checkbox using the same indicator as selectable dialog rows. */
export function Checkbox({
  mixed = false,
  className,
  ...props
}: Omit<ComponentProps<"input">, "defaultChecked" | "type"> & {
  checked: boolean;
  mixed?: boolean;
}) {
  return (
    <span
      className={cn(
        "relative flex size-4 shrink-0 items-center justify-center",
        className,
      )}
    >
      <input
        {...props}
        type="checkbox"
        className="peer absolute inset-0 z-10 size-4 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        ref={(input) => {
          if (input) input.indeterminate = mixed;
        }}
      />
      <CheckboxIndicator
        checked={props.checked}
        mixed={mixed}
        className="pointer-events-none peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-ring peer-disabled:opacity-40"
      />
    </span>
  );
}
