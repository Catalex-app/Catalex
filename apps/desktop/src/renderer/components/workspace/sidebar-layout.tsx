import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Slot } from "radix-ui";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Rows supply the 8px inner gutter, aligned with section header controls.
export function SidebarSectionBody({
  className,
  ...props
}: ComponentProps<"div">) {
  return <div data-sidebar-body className={cn("py-1", className)} {...props} />;
}

export function SidebarRow({
  asChild = false,
  depth = 0,
  className,
  style,
  type = "button",
  ...props
}: ComponentProps<"button"> & { asChild?: boolean; depth?: number }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      type={asChild ? undefined : type}
      data-sidebar-row
      className={cn(
        "flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      style={{ paddingLeft: 8 + depth * 16, ...style }}
      {...props}
    />
  );
}

export function SidebarRowIcon({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      data-sidebar-row-icon
      className={cn(
        "flex size-4 shrink-0 items-center justify-center",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarSectionHeader({
  title,
  icon,
  collapsed,
  onToggle,
  actions,
  section,
  label,
  wideActions = false,
}: {
  title: string;
  icon: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
  actions?: ReactNode;
  section?: string;
  label?: string;
  wideActions?: boolean;
}) {
  const content = (
    <>
      {onToggle && (
        <span className="absolute left-2 flex size-4 items-center justify-center text-muted-foreground">
          {collapsed ? (
            <ChevronRightIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
        </span>
      )}
      <span className="flex min-w-0 items-center justify-center gap-2">
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        <span className="truncate font-semibold text-xs">{title}</span>
      </span>
    </>
  );
  const titleClass = cn(
    "relative flex h-full w-full min-w-0 items-center justify-center",
    wideActions ? "px-13" : "px-8",
  );
  return (
    <div data-sidebar-header className="relative h-8 shrink-0">
      {onToggle ? (
        <button
          type="button"
          data-sidebar-toggle={section}
          aria-label={label ?? title}
          aria-expanded={!collapsed}
          onClick={onToggle}
          className={cn(
            titleClass,
            "rounded-md transition-colors hover:bg-sidebar-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-inset",
          )}
        >
          {content}
        </button>
      ) : (
        <div className={titleClass}>{content}</div>
      )}
      {actions && (
        <div
          data-sidebar-header-actions
          className="absolute inset-y-0 right-2 flex items-center gap-0.5"
        >
          {actions}
        </div>
      )}
    </div>
  );
}

// Measure untransformed text so every character fits without changing the control width.
export function SidebarFittedMarker({
  text,
  width = 16,
}: {
  text: string;
  width?: number;
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const container = containerRef.current;
    const label = textRef.current;
    if (!container || !label) return;
    const fit = () =>
      setScale(
        Math.min(1, container.clientWidth / Math.max(1, label.scrollWidth)),
      );
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    observer.observe(label);
    return () => observer.disconnect();
  }, [text, width]);
  return (
    <SidebarRowIcon ref={containerRef} style={{ width }}>
      <span
        ref={textRef}
        className={cn(
          "block shrink-0 whitespace-nowrap text-center",
          text.length > 2 ? "text-[8px]" : "text-[10px]",
        )}
        style={{ transform: `scaleX(${scale})` }}
      >
        {text}
      </span>
    </SidebarRowIcon>
  );
}

// Shared 32px rows: begin 4px into the first child and end 6px before its last edge.
export const SIDEBAR_GUIDE_CHILD_TOP = 4;
export const SIDEBAR_GUIDE_BOTTOM = 6;

export function SidebarTreeGuide({
  depth,
  top = 32 + SIDEBAR_GUIDE_CHILD_TOP,
  bottom = SIDEBAR_GUIDE_BOTTOM,
  style,
  ...props
}: ComponentProps<"span"> & {
  depth: number;
  top?: number | string;
  bottom?: number | string;
}) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute z-10 w-px bg-muted-foreground/25"
      style={{ left: depth * 16 + 15.5, top, bottom, ...style }}
      {...props}
    />
  );
}
