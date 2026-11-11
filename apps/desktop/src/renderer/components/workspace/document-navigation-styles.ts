export const documentCounterClassName =
  "flex h-7 shrink-0 items-center justify-center gap-px px-[5px] text-xs tabular-nums";

export const documentStepButtonClassName = "h-7 w-5 shrink-0";

export const documentBarClassName =
  "flex min-h-12 shrink-0 items-center gap-1 border-border border-b bg-background px-2 py-[7px] text-xs";

export const documentBarButtonClassName =
  "text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-muted";

export const documentBarControlHeightClassName = "h-8";

export const documentBarSummaryButtonClassName =
  "flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-muted-foreground text-xs tabular-nums transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const editorBarSummaryButtonClassName = `${documentBarSummaryButtonClassName} @max-[360px]/editor-header:w-7 @max-[360px]/editor-header:justify-center @max-[360px]/editor-header:px-0 @max-[360px]/editor-header:focus-visible:ring-inset @max-[360px]/editor-header:[&>[data-summary-count]]:hidden @max-[360px]/editor-header:[&>[data-summary-icon]]:flex`;

// The icon button is 30px and its separator with margins is 17px.
export const documentBarFindControlWidth = 47;
