import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared surface and interaction outlines; callers own layout, colors and selection.
 * Items expose aria-selected/aria-pressed, or data-button-group-item + data-active
 * for composite tabs whose nested action buttons should not receive an outline.
 */
function ButtonGroup({
  className,
  variant = "default",
  ...props
}: ComponentProps<"div"> & { variant?: "default" | "plain" }) {
  return (
    <div
      role="group"
      data-slot="button-group"
      className={cn(
        variant === "default" && "segmented-control rounded-lg bg-muted/50 p-1",
        className,
      )}
      {...props}
    />
  );
}

export { ButtonGroup };
