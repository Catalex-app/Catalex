import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { prepareTooltipExit } from "./tooltip-exit";

export const TOOLTIP_HOVER_DELAY_MS = 400;
const HasTooltipProvider = React.createContext(false);

function TooltipProvider({
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  const hoverDelay = useSettingsStore((s) => s.tooltipHoverDelay);
  return (
    <HasTooltipProvider.Provider value={true}>
      <TooltipPrimitive.Provider
        delayDuration={hoverDelay ? TOOLTIP_HOVER_DELAY_MS : 0}
        skipDelayDuration={0}
        {...props}
      >
        {children}
      </TooltipPrimitive.Provider>
    </HasTooltipProvider.Provider>
  );
}

function TooltipRoot({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const enabled = useSettingsStore((s) => s.showTooltips);
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen ?? false);
  React.useEffect(() => {
    if (!enabled) setInternalOpen(false);
  }, [enabled]);
  return (
    <TooltipPrimitive.Root
      {...props}
      open={enabled && (open ?? internalOpen)}
      onOpenChange={(next) => {
        setInternalOpen(enabled && next);
        onOpenChange?.(enabled && next);
      }}
    />
  );
}

function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const hasProvider = React.useContext(HasTooltipProvider);
  // Standalone editor widgets and component harnesses have their own React roots.
  return hasProvider ? (
    <TooltipRoot {...props} />
  ) : (
    <TooltipProvider>
      <TooltipRoot {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      className={cn(className, "disabled:pointer-events-auto")}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 0,
  ref: forwardedRef,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const revisionRef = React.useRef(0);
  const exitRef = React.useRef<ReturnType<typeof prepareTooltipExit>>(null);
  const ref = React.useCallback(
    (node: HTMLDivElement | null) => {
      const revision = ++revisionRef.current;
      const previous = contentRef.current;
      if (node) {
        exitRef.current?.cancel();
        exitRef.current = null;
      } else if (previous && useSettingsStore.getState().showTooltips) {
        const exit = prepareTooltipExit(previous);
        if (exit)
          queueMicrotask(() => {
            if (revisionRef.current !== revision) return;
            exitRef.current = exit;
            exit.play();
          });
      }
      contentRef.current = node;
      if (typeof forwardedRef === "function") return forwardedRef(node);
      if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );
  return (
    // Above body-portaled pickers (9999) and transient overlays (10000).
    // Radix copies this layer to its positioning wrapper and our exit snapshot.
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-[10010] w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) animate-in break-words rounded-md bg-foreground px-3 py-1.5 text-background text-xs motion-reduce:animate-none",
          className,
        )}
        {...props}
        ref={ref}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

/** Add an ordinary hint without inserting a layout wrapper or a native title. */
type HintProps = Omit<
  React.ComponentProps<typeof Slot>,
  "children" | "content"
> & {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: React.ComponentProps<typeof TooltipContent>["side"];
};

function Hint({ content, children, side, ...triggerProps }: HintProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Slot {...triggerProps}>{children}</Slot>
      </TooltipTrigger>
      {content != null && content !== "" && (
        <TooltipContent side={side}>{content}</TooltipContent>
      )}
    </Tooltip>
  );
}

export { Hint, Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
