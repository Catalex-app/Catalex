import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SettingsRow({
  id,
  title,
  titleAction,
  children,
  contentClassName,
}: {
  id?: string;
  title: string;
  titleAction?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}) {
  return (
    <div
      data-settings-row-id={id}
      className="grid min-h-10 scroll-mt-4 gap-3 border-border/45 border-t py-2 first:border-t-0 sm:grid-cols-[max-content_minmax(0,1fr)] sm:items-center"
    >
      <div className="flex min-h-8 min-w-0 items-center gap-1.5">
        <div className="whitespace-nowrap font-normal text-muted-foreground text-sm">
          {title}
        </div>
        {titleAction}
      </div>
      <div
        className={cn(
          "flex min-h-8 min-w-0 items-center justify-end font-mono font-normal text-foreground text-sm",
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function SettingsGroup({
  title,
  titleAction,
  children,
}: {
  title?: string;
  titleAction?: ReactNode;
  children: ReactNode;
}) {
  const normalizedTitle = title?.trim();

  return (
    <div>
      {normalizedTitle ? (
        <div className="flex items-center justify-between border-border/45 border-b pt-3 pb-1 font-semibold text-foreground text-xs">
          <span>{normalizedTitle}</span>
          {titleAction}
        </div>
      ) : null}
      <div>{children}</div>
    </div>
  );
}
