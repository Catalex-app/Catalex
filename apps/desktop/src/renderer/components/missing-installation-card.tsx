import type { ReactNode } from "react";

export function MissingInstallationCard({
  title,
  description,
  children,
  tone = "warning",
}: {
  tone?: "warning" | "error";
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`w-full overflow-hidden rounded-xl border bg-background p-4 ${tone === "error" ? "border-destructive/40" : "border-amber-500/40"}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className={`font-medium text-sm ${tone === "error" ? "text-destructive" : "text-amber-700 dark:text-amber-400"}`}
        >
          {title}
        </span>
      </div>
      <p className="mb-3 break-words text-muted-foreground text-sm">
        {description}
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
