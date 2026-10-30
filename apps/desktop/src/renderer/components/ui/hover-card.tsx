import * as React from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function HoverCard({
  openDelay = 200,
  closeDelay = 100,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return (
    <HoverCardPrimitive.Root
      data-slot="hover-card"
      openDelay={openDelay}
      closeDelay={closeDelay}
      {...props}
    />
  );
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  );
}

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "popup-glass popup-motion z-50 w-56 origin-(--radix-hover-card-content-transform-origin) rounded-lg border border-[color:var(--popup-surface-border,var(--border))] bg-[var(--popup-surface-background,var(--popover))] p-3 text-popover-foreground shadow-[0_0_0_transparent,var(--popup-surface-shadow,var(--shadow-md))] outline-hidden",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
