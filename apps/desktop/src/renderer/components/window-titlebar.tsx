import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface TrafficLightSafeHeaderProps {
  children?: ReactNode;
  trailing?: ReactNode;
  className?: string;
  trafficLightInset?: number;
}

export function TrafficLightSafeHeader({
  children,
  trailing,
  className,
  trafficLightInset,
}: TrafficLightSafeHeaderProps) {
  return (
    <div
      className={cn("relative flex h-10 shrink-0 items-center px-2", className)}
    >
      <div
        className="w-[var(--traffic-light-width)] shrink-0"
        style={
          trafficLightInset !== undefined
            ? { width: `${trafficLightInset}px` }
            : undefined
        }
        aria-hidden="true"
      />
      {children}
      <div data-window-drag-region className="min-w-0 flex-1 self-stretch" />
      {trailing}
    </div>
  );
}
