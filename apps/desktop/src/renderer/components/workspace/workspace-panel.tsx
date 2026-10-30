import type { ComponentPropsWithRef, ComponentProps } from "react";
import { PanelResizeHandle } from "react-resizable-panels";
import { cn } from "@/lib/utils";

/** The shared visual boundary of live and historical workspace panes. */
export function WorkspacePanel({
  className,
  ...props
}: ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn(
        "min-h-0 overflow-hidden rounded-panel border border-border/70 bg-card",
        className,
      )}
      {...props}
    />
  );
}

type WorkspacePanelHeaderProps =
  | ({ as?: "div" } & ComponentPropsWithRef<"div">)
  | ({ as: "header" } & ComponentPropsWithRef<"header">);

/** One toolbar height and surface; each pane supplies its own content. */
export function WorkspacePanelHeader(props: WorkspacePanelHeaderProps) {
  const baseClassName =
    "flex h-12 shrink-0 items-center border-border border-b bg-background px-2";
  if (props.as === "header") {
    const { as: _as, className, ...headerProps } = props;
    return <header className={cn(baseClassName, className)} {...headerProps} />;
  }
  const { as: _as, className, ...divProps } = props;
  return <div className={cn(baseClassName, className)} {...divProps} />;
}

/** The plain workspace gutter, without live editor navigation controls. */
export function WorkspacePanelResizeHandle({
  collapsed = false,
  className,
  disabled,
  tabIndex,
  ...props
}: ComponentProps<typeof PanelResizeHandle> & { collapsed?: boolean }) {
  return (
    <PanelResizeHandle
      {...props}
      disabled={collapsed || disabled}
      tabIndex={collapsed ? -1 : tabIndex}
      className={cn(
        collapsed
          ? "pointer-events-none mx-0 w-0 bg-transparent"
          : "mx-0.5 w-1 bg-transparent",
        className,
      )}
    />
  );
}
