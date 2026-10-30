import { useEffect, useRef } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const SIMPLE_GIT_ARGUMENT = /^[a-zA-Z0-9_./:@%+=,-]+$/;

function quoteGitArgument(value: string): string {
  if (SIMPLE_GIT_ARGUMENT.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatGitCommand(args: string[]): string {
  return ["git", ...args].map(quoteGitArgument).join(" ");
}

export function GitCommandDisclosure({
  commands,
  expanded,
  onExpandedChange,
}: {
  commands: string[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const previewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!expanded) return;
    const frame = window.requestAnimationFrame(() => {
      previewRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded]);

  return (
    <div className="min-w-0 pt-0.5">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
        className="flex items-center gap-1.5 rounded-md px-1 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted/35 hover:text-foreground"
      >
        <ChevronDownIcon
          className={cn(
            "size-3.5 transition-transform",
            expanded ? "rotate-0" : "-rotate-90",
          )}
        />
        <span>Show git command</span>
      </button>
      {expanded ? (
        <div
          ref={previewRef}
          data-testid="git-command-preview"
          className="app-scrollbar mt-1 max-h-28 w-full min-w-0 max-w-full space-y-1 overflow-y-auto overflow-x-hidden rounded-lg border border-border/60 bg-background/70 px-2.5 py-2 dark:bg-muted/70"
        >
          {commands.length > 0 ? (
            commands.map((command) => (
              <code
                key={command}
                className="block min-w-0 whitespace-pre-wrap break-words font-mono text-[11px] text-foreground leading-4"
              >
                {command}
              </code>
            ))
          ) : (
            <span className="text-[11px] text-muted-foreground">
              No Git command will run.
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
