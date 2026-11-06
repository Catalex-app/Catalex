import { Hint } from "@/components/ui/tooltip";
import { ButtonGroup } from "@/components/ui/button-group";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  XIcon,
  ChevronDown,
  ChevronUp,
  CircleXIcon,
  TriangleAlertIcon,
  InfoIcon,
  MousePointerClickIcon,
} from "lucide-react";

export interface DiagnosticItem {
  from: number | null;
  to: number | null;
  severity: string;
  message: string;
  line: number | null;
  source?: "compile";
}

interface ProblemsPanelProps {
  navigationSelection?: { diagnostics: DiagnosticItem[] };
  diagnostics: DiagnosticItem[];
  fileName: string;
  onClose?: () => void;
  onNavigate: (from: number) => void;
  onFixAllWithChat?: (diagnostics: DiagnosticItem[]) => void;
}

function SeverityIcon({ severity }: { severity: string }) {
  switch (severity) {
    case "error":
      return (
        <CircleXIcon className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
      );
    case "warning":
      return (
        <TriangleAlertIcon className="size-3.5 shrink-0 text-yellow-600 dark:text-yellow-400" />
      );
    default:
      return <InfoIcon className="size-3.5 shrink-0 text-blue-400" />;
  }
}

export function ProblemsSummaryButton({
  diagnostics,
  onOpen,
}: {
  diagnostics: DiagnosticItem[];
  onOpen: () => void;
}) {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  if (errors + warnings === 0) return null;
  return (
    <Hint content={`Show problems (${errors} errors, ${warnings} warnings)`}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Show problems: ${errors} errors, ${warnings} warnings`}
        className="flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-muted-foreground text-xs tabular-nums transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-1">
          <SeverityIcon severity="error" />
          {errors}
        </span>
        <span className="flex items-center gap-1">
          <SeverityIcon severity="warning" />
          {warnings}
        </span>
      </button>
    </Hint>
  );
}

export function ProblemsPanel({
  navigationSelection,
  diagnostics,
  fileName,
  onClose,
  onNavigate,
  onFixAllWithChat,
}: ProblemsPanelProps) {
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter(
    (d) => d.severity === "warning",
  ).length;
  const [activeSeverity, setSeverityFilter] = useState<
    "all" | "error" | "warning"
  >("all");
  const visibleDiagnostics = diagnostics.filter(
    (d) =>
      (d.severity === "error" || d.severity === "warning") &&
      (activeSeverity === "all" || d.severity === activeSeverity),
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const currentIndex = Math.min(
    selectedIndex,
    Math.max(0, visibleDiagnostics.length - 1),
  );
  const currentDiagnostic = visibleDiagnostics[currentIndex];

  useEffect(() => {
    setSelectedIndex(0);
    setSeverityFilter("all");
  }, [fileName]);

  useEffect(() => {
    setSelectedIndex((index) =>
      Math.min(index, Math.max(0, visibleDiagnostics.length - 1)),
    );
  }, [visibleDiagnostics.length]);

  useEffect(() => {
    if (!navigationSelection) return;
    const target = navigationSelection.diagnostics.find((item) =>
      visibleDiagnostics.includes(item),
    );
    if (!target) return;
    const index = visibleDiagnostics.indexOf(target);
    setSelectedIndex(index);
  }, [navigationSelection]);

  const navigateIssue = (direction: number) => {
    if (!visibleDiagnostics.length) return;
    const index =
      (currentIndex + direction + visibleDiagnostics.length) %
      visibleDiagnostics.length;
    setSelectedIndex(index);
    const from = visibleDiagnostics[index].from;
    if (from !== null) onNavigate(from);
  };

  const navigateCurrent = () => {
    if (currentDiagnostic?.from != null) onNavigate(currentDiagnostic.from);
  };
  const location =
    currentDiagnostic?.line != null
      ? `${fileName}:${currentDiagnostic.line}`
      : fileName;

  return (
    <div
      data-problems-panel="true"
      className="@container/problems flex h-12 shrink-0 items-center gap-3 border-border border-b bg-background pr-2 pl-3"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 text-xs">
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-medium text-foreground">Problems</span>
          <ButtonGroup
            role="group"
            aria-label="Problem severity"
            className="flex h-8 shrink-0 items-center"
          >
            {(
              [
                {
                  severity: "all",
                  label: "All",
                  count: errorCount + warningCount,
                  Icon: null,
                },
                {
                  severity: "error",
                  label: "Errors",
                  count: errorCount,
                  Icon: CircleXIcon,
                },
                {
                  severity: "warning",
                  label: "Warnings",
                  count: warningCount,
                  Icon: TriangleAlertIcon,
                },
              ] as const
            ).map(({ severity, label, count, Icon }) => (
              <Hint
                content={`Show ${label.toLowerCase()} (${count})`}
                key={severity}
              >
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={activeSeverity === severity}
                  className={cn(
                    "flex h-6 items-center justify-center gap-1 rounded-md px-2 font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    activeSeverity === severity
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                  )}
                  onClick={() => {
                    setSeverityFilter(severity);
                    setSelectedIndex(0);
                  }}
                >
                  {Icon ? (
                    <Icon
                      className={cn(
                        "size-3",
                        severity === "error"
                          ? "text-red-600 dark:text-red-400"
                          : "text-yellow-600 dark:text-yellow-400",
                      )}
                    />
                  ) : (
                    <span>All</span>
                  )}
                  <span>{count}</span>
                </button>
              </Hint>
            ))}
          </ButtonGroup>
        </div>
        {!currentDiagnostic && (
          <span className="text-muted-foreground" role="status">
            No{" "}
            {activeSeverity === "all"
              ? "problems"
              : activeSeverity === "error"
                ? "errors"
                : "warnings"}
          </span>
        )}
        {currentDiagnostic && (
          <Hint
            content={`${currentDiagnostic.source === "compile" ? "Last compile — " : ""}${location} ${currentDiagnostic.message}`}
          >
            <div
              role={currentDiagnostic.from !== null ? "button" : undefined}
              tabIndex={currentDiagnostic.from !== null ? 0 : undefined}
              className={`group flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors ${currentDiagnostic.from !== null ? "cursor-pointer hover:bg-muted/50" : ""}`}
              onClick={
                currentDiagnostic.from !== null ? navigateCurrent : undefined
              }
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                navigateCurrent();
              }}
            >
              <SeverityIcon severity={currentDiagnostic.severity} />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {currentDiagnostic.message}
              </span>
              {currentDiagnostic.line == null && (
                <Hint content="No reliable source location is available. Recompile to refresh this message.">
                  <span className="shrink-0 text-muted-foreground">
                    General
                  </span>
                </Hint>
              )}
            </div>
          </Hint>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {visibleDiagnostics.length > 0 && (
          <>
            <span
              className="px-1 font-mono text-muted-foreground text-xs"
              role="status"
              aria-label={`Problem ${currentIndex + 1} of ${visibleDiagnostics.length}`}
            >
              {currentIndex + 1}/{visibleDiagnostics.length}
            </span>
            <Hint content="Previous problem">
              <button
                type="button"
                onClick={() => navigateIssue(-1)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                aria-label="Previous problem"
              >
                <ChevronUp className="size-3.5" />
              </button>
            </Hint>
            <Hint content="Next problem">
              <button
                type="button"
                onClick={() => navigateIssue(1)}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                aria-label="Next problem"
              >
                <ChevronDown className="size-3.5" />
              </button>
            </Hint>
          </>
        )}
        {visibleDiagnostics.length > 0 && onFixAllWithChat && (
          <>
            <div className="mx-0.5 h-4 w-px bg-border" />
            <Hint
              content={`Fix all ${activeSeverity === "all" ? "problems" : activeSeverity === "error" ? "errors" : "warnings"} with AI`}
            >
              <button
                type="button"
                onClick={() => onFixAllWithChat(visibleDiagnostics)}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2",
                  activeSeverity === "all"
                    ? "bg-muted text-foreground hover:bg-muted/80 focus-visible:ring-ring"
                    : activeSeverity === "error"
                      ? "bg-red-100 text-red-700 hover:bg-red-200 focus-visible:ring-red-300/60 dark:bg-red-600/20 dark:text-red-300 dark:focus-visible:ring-red-400/40 dark:hover:bg-red-600/30"
                      : "bg-amber-100 text-amber-700 hover:bg-amber-200 focus-visible:ring-amber-300/60 dark:bg-amber-400/10 dark:text-amber-300 dark:focus-visible:ring-amber-400/40 dark:hover:bg-amber-400/20",
                )}
                aria-label="Fix with Chat"
              >
                <MousePointerClickIcon className="size-3" />
                <span>
                  Fix
                  <span className="@[640px]/problems:inline hidden">
                    {" "}
                    with Chat
                  </span>
                </span>
              </button>
            </Hint>
          </>
        )}
        {onClose && (
          <Hint content="Hide problems">
            <button
              type="button"
              onClick={onClose}
              aria-label="Hide problems"
              className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <XIcon className="size-3.5" />
            </button>
          </Hint>
        )}
      </div>
    </div>
  );
}
