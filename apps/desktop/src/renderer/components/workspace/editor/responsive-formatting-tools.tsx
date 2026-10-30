import { Hint } from "@/components/ui/tooltip";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, TypeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/** Measure the actual remaining header space, including changing status counts. */
export function ResponsiveFormattingTools({
  children,
}: {
  children: ReactNode;
}) {
  const availableRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const available = availableRef.current;
    const tools = toolsRef.current;
    if (!available || !tools) return;
    const measure = () => {
      const needsMenu =
        tools.getBoundingClientRect().width >
        available.getBoundingClientRect().width;
      setCollapsed(needsMenu);
      if (!needsMenu) setOpen(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(available);
    observer.observe(tools);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={availableRef}
      data-formatting-collapsed={collapsed}
      className="relative min-w-11 flex-1"
    >
      <div
        ref={toolsRef}
        aria-hidden={collapsed || undefined}
        inert={collapsed}
        className={
          collapsed
            ? "pointer-events-none invisible absolute top-0 left-0 w-max"
            : "w-max"
        }
      >
        {children}
      </div>
      {collapsed && (
        <Popover open={open} onOpenChange={setOpen}>
          <Hint content="Formatting options">
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2"
                aria-label="Formatting options"
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
      )}
    </div>
  );
}
