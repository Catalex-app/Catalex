import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { getContextMenuCoordinator } from "@/lib/context-menu-coordinator";

const ContextMenuOpenContext = React.createContext(false);

function ContextMenu({
  onOpenChange,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  const [open, setOpen] = React.useState(false);
  return (
    <ContextMenuOpenContext.Provider value={open}>
      <ContextMenuPrimitive.Root
        data-slot="context-menu"
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          onOpenChange?.(nextOpen);
        }}
        {...props}
      />
    </ContextMenuOpenContext.Provider>
  );
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  const open = React.useContext(ContextMenuOpenContext);
  return (
    <ContextMenuPrimitive.Trigger
      {...props}
      data-slot="context-menu-trigger"
      data-context-menu-open={open || undefined}
    />
  );
}

function ContextMenuContent({
  portalContainer,
  className,
  onKeyDown,
  onKeyUp,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> & {
  portalContainer?: HTMLElement;
}) {
  const open = React.useContext(ContextMenuOpenContext);
  const [content, setContent] = React.useState<HTMLDivElement | null>(null);
  const release = React.useRef<(() => void) | null>(null);
  React.useLayoutEffect(() => {
    if (!open || !content) return;
    const coordinator = getContextMenuCoordinator(
      portalContainer?.ownerDocument ?? document,
    );
    const menu = Symbol("context-menu");
    coordinator.acquire(menu, content);
    const cleanup = () => coordinator.release(menu);
    release.current = cleanup;
    return cleanup;
  }, [open, portalContainer, content]);
  return (
    <ContextMenuPrimitive.Portal container={portalContainer}>
      <ContextMenuPrimitive.Content
        ref={setContent}
        data-slot="context-menu-content"
        collisionPadding={14}
        className={cn(
          "app-scrollbar popup-glass popup-motion z-50 max-h-(--radix-context-menu-content-available-height) min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border border-[color:var(--popup-surface-border,var(--border))] bg-[var(--popup-surface-background,var(--popover))] p-1 text-popover-foreground shadow-[0_0_0_transparent,var(--popup-surface-shadow,var(--shadow-md))]",
          className,
        )}
        {...props}
        onEscapeKeyDown={(event) => {
          // Restore background focusability before the caller restores focus.
          release.current?.();
          onEscapeKeyDown?.(event);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          event.stopPropagation();
        }}
        onKeyUp={(event) => {
          onKeyUp?.(event);
          event.stopPropagation();
        }}
      />
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "data-[variant=destructive]:*:[svg]:!text-destructive relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[disabled]:opacity-50 data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

/** Two-step menu action shared by file deletion and chat archiving. */
function ContextMenuConfirmItem({
  label,
  icon: Icon,
  tone = "destructive",
  disabled,
  onConfirm,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "destructive" | "neutral";
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const open = React.useContext(ContextMenuOpenContext);
  React.useEffect(() => {
    // Content remains mounted during its exit animation; reset on close too.
    if (!open || disabled) setConfirming(false);
  }, [open, disabled]);
  return (
    <ContextMenuItem
      variant={tone === "destructive" ? "destructive" : "default"}
      className="trash-context-menu-item"
      data-tone={tone}
      data-confirming={confirming}
      aria-label={confirming ? "Confirm" : label}
      textValue={confirming ? "Confirm" : label}
      disabled={disabled}
      onSelect={(event) => {
        if (!confirming) {
          event.preventDefault();
          setConfirming(true);
          return;
        }
        setConfirming(false);
        onConfirm();
      }}
    >
      <span className="trash-menu-label" aria-hidden="true">
        <Icon
          className={cn(
            "mr-2 size-4",
            tone === "destructive" && "text-current",
          )}
        />
        {label}
      </span>
      <span className="trash-menu-confirmation" aria-hidden="true">
        <Icon className="mr-2 size-4 text-current" />
        Confirm
      </span>
    </ContextMenuItem>
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuConfirmItem,
};
