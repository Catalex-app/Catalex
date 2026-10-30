import { DialogResizeTransition } from "./dialog-resize-transition";
import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in",
        className,
      )}
      {...props}
    />
  );
}

const dialogWidths = {
  compact: "sm:max-w-[420px]",
  wide: "sm:max-w-[720px]",
} as const;

function DialogContent({
  className,
  children,
  showCloseButton = true,
  size = "compact",
  overlayClassName,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  size?: keyof typeof dialogWidths;
  overlayClassName?: string;
}) {
  return (
    <DialogResizeTransition>
      {(motionRef) => (
        <DialogPortal data-slot="dialog-portal">
          <DialogOverlay className={overlayClassName} />
          <DialogPrimitive.Content
            ref={motionRef}
            data-slot="dialog-content"
            className={cn(
              "popup-glass popup-motion fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border border-[color:var(--popup-surface-border,var(--border))] bg-[var(--popup-surface-background,var(--background))] p-6 shadow-[0_0_0_transparent,var(--popup-surface-shadow,var(--shadow-lg))] outline-none duration-200",
              dialogWidths[size],
              className,
            )}
            {...props}
          >
            {children}
            {showCloseButton && (
              <DialogPrimitive.Close
                data-slot="dialog-close"
                className="absolute top-4 right-4 flex size-8 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground transition-colors hover:text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none dark:bg-muted [&_svg]:pointer-events-none [&_svg]:shrink-0"
              >
                <XIcon className="size-4" />
                <span className="sr-only">Close</span>
              </DialogPrimitive.Close>
            )}
          </DialogPrimitive.Content>
        </DialogPortal>
      )}
    </DialogResizeTransition>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogIconHeader({
  children,
  closeDisabled = false,
  showCloseButton = true,
}: {
  children: React.ReactNode;
  closeDisabled?: boolean;
  showCloseButton?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="inline-flex min-h-8 min-w-8 items-center justify-center gap-2 rounded-lg border border-border/70 bg-background px-1.5 py-1.5 text-muted-foreground dark:bg-muted [&_svg]:size-4 [&_svg]:shrink-0">
        {children}
      </div>
      {showCloseButton && (
        <DialogClose asChild>
          <button
            type="button"
            aria-label="Close"
            disabled={closeDisabled}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 dark:bg-muted"
          >
            <XIcon className="size-4" />
          </button>
        </DialogClose>
      )}
    </div>
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("font-semibold text-lg leading-none", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-foreground/80 text-sm", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogIconHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
