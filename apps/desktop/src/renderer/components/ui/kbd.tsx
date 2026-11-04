import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Shared keycap for shortcut settings and menu hints. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex min-w-5 shrink-0 items-center justify-center whitespace-nowrap rounded border border-border bg-muted/60 px-1 py-0.5 text-center font-mono text-[11px] leading-4 shadow-xs",
        className,
      )}
      {...props}
    />
  );
}
