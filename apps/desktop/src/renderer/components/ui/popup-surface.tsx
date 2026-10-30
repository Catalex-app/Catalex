import type { ComponentProps, ReactNode } from "react";
import { usePopupExit } from "./use-popup-exit";
import { cn } from "@/lib/utils";

// Shared by Radix menus/popovers and custom positioned popup surfaces.
export const popupSurfaceClassName =
  "rounded-xl border border-[color:var(--popup-surface-border,var(--border))] popup-glass popup-motion bg-[var(--popup-surface-background,var(--popover))] p-1 text-popover-foreground text-sm shadow-[0_0_0_transparent,var(--popup-surface-shadow,var(--shadow-lg))]";
export const popupTitleClassName =
  "px-2 py-1.5 text-center font-semibold text-xs";
export const popupSeparatorClassName = "mx-2 my-1 h-px shrink-0 bg-border";

export function PopupSurface({
  className,
  ref,
  ...props
}: ComponentProps<"div">) {
  const popupRef = usePopupExit(ref);
  return (
    <div
      ref={popupRef}
      data-ui-surface="popover"
      className={cn(popupSurfaceClassName, className)}
      {...props}
    />
  );
}

export function PopupHeader({
  children,
  action,
  className,
  ...props
}: ComponentProps<"div"> & { action?: ReactNode }) {
  return (
    <div
      className={cn(
        "relative shrink-0",
        popupTitleClassName,
        action && "px-9",
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-center gap-1.5">{children}</div>
      {action && (
        <div className="absolute inset-y-0 right-1 flex items-center">
          {action}
        </div>
      )}
    </div>
  );
}

export function PopupSeparator({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="separator"
      className={cn(popupSeparatorClassName, className)}
      {...props}
    />
  );
}
