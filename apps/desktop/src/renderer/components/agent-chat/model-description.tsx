import { useLayoutEffect, useRef, useState } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

export function ModelDescription({ description }: { description: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const nextClipped = element.scrollWidth > element.clientWidth;
      setClipped(nextClipped);
      if (!nextClipped) setOpen(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [description]);

  return (
    <Tooltip
      open={clipped && open}
      onOpenChange={(next) => setOpen(clipped && next)}
    >
      <TooltipTrigger asChild>
        <div
          ref={ref}
          data-model-description=""
          className="truncate text-muted-foreground text-xs"
        >
          {description}
        </div>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
}
