import {
  chatContextItems,
  isSelectionRangeContextLabel,
  type ChatContextBadge,
  type ChatPromptContext,
} from "./chat-context";

function formatAttachment(context: ChatContextBadge): string {
  const comment = context.comment;
  if (comment) {
    const location = [
      comment.line === undefined ? null : `line ${comment.line}`,
      comment.from === undefined || comment.to === undefined
        ? null
        : `offsets ${comment.from}–${comment.to}`,
    ]
      .filter(Boolean)
      .join(", ");
    return [
      "[Attached comment — snapshot]",
      `Label: ${comment.label ?? context.label.split(" · ")[0]}`,
      `ID: ${comment.id}`,
      `File: ${context.filePath}`,
      `Created by: ${comment.agent ? "agent" : "human"}`,
      ...(comment.resolved === undefined
        ? []
        : [`Status: ${comment.resolved ? "resolved" : "open"}`]),
      ...(location ? [`Location: ${location}`] : []),
      `Comment:\n${comment.text}`,
    ].join("\n");
  }
  const range = context.label.match(
    /:(\d+):(\d+)-(\d+):(\d+)(?: · PDF p\.\d+)?$/,
  );
  return [
    context.imageDataUrl
      ? "[Attached image]"
      : context.pdf || isSelectionRangeContextLabel(context.label)
        ? "[Selected text]"
        : "[Attached file]",
    `File: ${context.filePath}`,
    ...(context.pdf
      ? [
          `${context.pdf.kind === "compiled" ? "PDF compiled from" : "PDF document"}: ${context.pdf.documentPath}`,
          `PDF page: ${context.pdf.page}`,
        ]
      : []),
    ...(context.proposedDraft
      ? [
          "Source: Agent proposed draft (captured snapshot; locations may have changed).",
          `Draft session: ${context.proposedDraft.sessionId}`,
          ...(context.proposedDraft.contentVersion
            ? [`Captured version: ${context.proposedDraft.contentVersion}`]
            : []),
        ]
      : []),
    ...(range
      ? [
          `Range: line ${range[1]}, column ${range[2]} to line ${range[3]}, column ${range[4]}`,
        ]
      : [`Label: ${context.label}`]),
    `Text:\n${context.selectedText}`,
    ...(context.diagnostics?.length
      ? [
          `Detected issues:\n${context.diagnostics
            .map(
              (issue) =>
                `- ${context.filePath}${issue.line === null ? "" : `:${issue.line}`} — [${issue.severity}] ${issue.message}`,
            )
            .join("\n")}`,
        ]
      : []),
  ].join("\n");
}

/** One formatter for both providers; attachment content is context, not a request. */
export function formatChatPrompt(
  userPrompt: string,
  activeFilePath?: string,
  context?: ChatPromptContext,
): string {
  const items = chatContextItems(context);
  if (!activeFilePath && !items.length) return userPrompt;
  return [
    ...(activeFilePath ? [`[Currently open file: ${activeFilePath}]`] : []),
    ...items.map(formatAttachment),
    `[User request]\n${userPrompt}`,
  ].join("\n\n");
}
