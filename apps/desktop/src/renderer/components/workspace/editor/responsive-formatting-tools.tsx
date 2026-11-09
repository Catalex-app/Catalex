import { Hint } from "@/components/ui/tooltip";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, TypeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspacePanelMotion } from "../workspace-panel";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** Measure the actual remaining header space, including changing status counts. */
export function ResponsiveFormattingTools({
  children,
  forceCollapsed = false,
  disabled = false,
}: {
  children: ReactNode;
  forceCollapsed?: boolean;
  disabled?: boolean;
}) {
  const availableRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const animating = useWorkspacePanelMotion()?.animating ?? false;

  useLayoutEffect(() => {
    const available = availableRef.current;
    const tools = toolsRef.current;
    if (!available || !tools) return;
    const measure = () => {
      const toolsWidth = tools.getBoundingClientRect().width;
      const availableWidth = available.getBoundingClientRect().width;
      setCollapsed((wasCollapsed) => {
        if (forceCollapsed || toolsWidth > availableWidth) return true;
        // Reveal once the panel settles, with breathing room at the cutoff.
        // An open formatting menu stays usable while its pane is resized.
        if (
          wasCollapsed &&
          (animating || open || availableWidth < toolsWidth + 16)
        )
          return true;
        return false;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(available);
    observer.observe(tools);
    return () => observer.disconnect();
  }, [animating, open, forceCollapsed]);

  return (
    <div
      ref={availableRef}
      data-formatting-collapsed={collapsed}
      className="relative h-7 min-w-11 flex-1 overflow-hidden"
    >
      <div
        ref={toolsRef}
        aria-hidden={collapsed || undefined}
        inert={collapsed}
        className="absolute top-0 left-0 w-max transition-opacity duration-150 ease-out motion-reduce:transition-none"
        style={{
          opacity: collapsed ? 0 : 1,
          pointerEvents: collapsed ? "none" : undefined,
        }}
      >
        {children}
      </div>
      <div
        aria-hidden={!collapsed || undefined}
        inert={!collapsed}
        className="absolute top-0 left-0 transition-opacity duration-150 ease-out motion-reduce:transition-none"
        style={{
          opacity: collapsed ? 1 : 0,
          pointerEvents: collapsed ? undefined : "none",
        }}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <Hint content="Formatting options">
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2"
                aria-label="Formatting options"
                disabled={disabled}
              >
                <TypeIcon className="size-3.5" />
                <ChevronDownIcon className="size-3" />
              </Button>
            </PopoverTrigger>
          </Hint>
          <PopoverContent
            align="start"
            sideOffset={6}
            aria-label="Formatting options"
            className="w-max max-w-[calc(100vw-1rem)] p-2 [&>div]:min-w-0 [&>div]:flex-wrap"
            onCloseAutoFocus={(event) => {
              // Formatting returns focus to the editor; Escape returns to the trigger.
              if (document.activeElement?.closest(".cm-editor"))
                event.preventDefault();
            }}
          >
            {children}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
