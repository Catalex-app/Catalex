import type { PdfCommentAnchor } from "@/components/workspace/editor/inline-comments";
import type { PdfSource } from "./mupdf/pdf-source";
import type { PdfTextRange } from "./mupdf/types";

export interface PdfSelectionAnchor {
  fingerprint: string;
  ranges: PdfTextRange[];
  regions?: PdfCommentAnchor["regions"];
  source: PdfSource;
}

export interface ChatContextBadge {
  label: string;
  filePath: string;
  selectedText: string;
  selectionPinned?: boolean;
  selectionKey?: string;
  pdf?: {
    /** Project-relative TeX root or directly opened PDF path. */
    documentPath: string;
    kind: "compiled" | "file";
    page: number;
  };
  imageDataUrl?: string;
  attachment?: boolean;
  proposedDraft?: { sessionId: string; contentVersion?: string };
  diagnostics?: Array<{
    line: number | null;
    severity: string;
    message: string;
  }>;
  comment?: {
    id: string;
    agent: boolean;
    text: string;
    label?: string;
    resolved?: boolean;
    line?: number;
    from?: number;
    to?: number;
  };
}

export function isSelectionRangeContextLabel(label: string): boolean {
  return (
    /:\d+:\d+-\d+:\d+(?: · PDF p\.\d+)?$/.test(label) ||
    /^PDF (?:p\.\d+ · (?:@.+ · )?“.*”|· p\. \d+)$/.test(label)
  );
}

export function pdfSelectionKey(
  pdf: NonNullable<ChatContextBadge["pdf"]>,
  x: number,
  y: number,
  text: string,
): string {
  // SVG coordinates can differ by floating-point noise across viewer scales.
  // A hundredth of a PDF point retains position without treating that as a new excerpt.
  return `pdf:${JSON.stringify([
    pdf.kind,
    pdf.documentPath,
    pdf.page,
    Number(x.toFixed(2)),
    Number(y.toFixed(2)),
    text,
  ])}`;
}

/** PDF excerpts must never fall back to matching text from another document. */
export function isSameSelectionContext(
  a: ChatContextBadge,
  b: ChatContextBadge,
): boolean {
  if (a.pdf || b.pdf) {
    return Boolean(
      a.pdf &&
        b.pdf &&
        a.pdf.documentPath === b.pdf.documentPath &&
        a.pdf.kind === b.pdf.kind &&
        a.selectionKey &&
        a.selectionKey === b.selectionKey,
    );
  }
  return Boolean(
    (a.selectionKey && a.selectionKey === b.selectionKey) ||
      (a.filePath === b.filePath &&
        a.label === b.label &&
        a.selectedText === b.selectedText),
  );
}

/** Single-context callers and saved paused requests remain supported. */
export type ChatPromptContext =
  | ChatContextBadge[]
  | (ChatContextBadge & { imageDataUrls?: string[] });

export function chatContextItems(
  context?: ChatPromptContext,
): Array<ChatContextBadge & { imageDataUrls?: string[] }> {
  return !context ? [] : Array.isArray(context) ? context : [context];
}

/** Stable identity for a captured text version; never used as an authorization hash. */
export function draftContentVersion(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
  }
  return `${content.length}:${hash >>> 0}`;
}

export function captureProposedDraft(
  sessionId: string | null,
  content?: string,
) {
  return sessionId
    ? {
        sessionId,
        contentVersion:
          content === undefined ? undefined : draftContentVersion(content),
      }
    : undefined;
}

export function isEarlierDraftContext(
  context: ChatContextBadge,
  sessionId: string | null,
  content?: string,
): boolean {
  const draft = context.proposedDraft;
  return Boolean(
    draft &&
      (draft.sessionId !== sessionId ||
        (draft.contentVersion !== undefined &&
          (content === undefined ||
            draft.contentVersion !== draftContentVersion(content)))),
  );
}
