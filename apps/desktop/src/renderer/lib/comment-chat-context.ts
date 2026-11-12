import type {
  InlineEditorComment,
  PdfCommentAnchor,
} from "@/components/workspace/editor/inline-comments";
import { validPdfCommentRegions } from "@/components/workspace/preview/pdf-file-comments";
import { useDocumentStore } from "@/stores/document-store";
import { SELECTION_OWNER_EVENT } from "./workspace-events";
import type { ChatContextBadge, PdfSelectionAnchor } from "./chat-context";
import { recoverPdfCommentRanges } from "./mupdf/pdf-comment-passage";
import { getOrOpenDocument } from "./mupdf/pdf-doc-cache";
import { getMupdfClient } from "./mupdf/mupdf-client";
import type { PdfSource } from "./mupdf/pdf-source";
import type { PdfTextRange, StructuredTextData } from "./mupdf/types";
import { isReferencePanelWindow } from "./panel-window-runtime";

export function commentChatContext(
  filePath: string,
  comment: InlineEditorComment,
): ChatContextBadge {
  const label = `${comment.origin ? "A" : "H"}-${comment.number ?? comment.expectedNumber ?? 1}`;
  return {
    label: `${label} · ${filePath}`,
    filePath,
    ...(comment.pdf
      ? {
          pdf: {
            documentPath: filePath,
            kind: "file" as const,
            page: comment.pdf.regions[0].page,
          },
        }
      : {}),
    selectionKey: `comment:${JSON.stringify([filePath, comment.id])}`,
    comment: {
      id: comment.id,
      agent: Boolean(comment.origin),
      text: comment.text,
      label,
      resolved: Boolean(comment.resolved),
      line: comment.line,
      from: comment.from,
      to: comment.to,
    },
    selectedText: comment.pdf?.text ?? comment.text,
  };
}

export function attachCommentToChat(
  projectRoot: string | null,
  filePath: string,
  comment: InlineEditorComment,
) {
  const document = useDocumentStore.getState();
  if (
    isReferencePanelWindow() ||
    !projectRoot ||
    document.projectRoot !== projectRoot ||
    document.agentWorkspaceRoot ||
    !comment.text.trim()
  )
    return;
  document.setSelectionRange(null);
  window.dispatchEvent(
    new CustomEvent(SELECTION_OWNER_EVENT, { detail: "none" }),
  );
  document.setCommentSelectionContext(commentChatContext(filePath, comment));
}

export function commentsInSelection(
  filePath: string,
  comments: InlineEditorComment[],
  start: number,
  end: number,
): ChatContextBadge[] {
  return comments
    .filter(
      (comment) =>
        !comment.resolved &&
        comment.text.trim() &&
        comment.from < end &&
        comment.to > start,
    )
    .map((comment) => commentChatContext(filePath, comment));
}

export function commentsInPdfSelection(
  filePath: string,
  comments: InlineEditorComment[],
  selection: PdfSelectionAnchor,
  recovered?: ReadonlyMap<PdfCommentAnchor, PdfTextRange[]>,
): ChatContextBadge[] {
  const selectedByPage = new Map(
    selection.ranges.map((range) => [range.page, range]),
  );
  return comments
    .filter(
      ({ pdf, resolved, text }) =>
        !resolved &&
        text.trim() &&
        pdf?.fingerprint === selection.fingerprint &&
        validPdfCommentRegions(pdf.regions) &&
        recovered?.get(pdf)?.some((range) => {
          const selected = selectedByPage.get(range.page);
          return (
            selected && range.from < selected.to && selected.from < range.to
          );
        }),
    )
    .map((comment) => commentChatContext(filePath, comment));
}

const recoveredBySource = new WeakMap<
  PdfSource,
  Map<string, Promise<PdfTextRange[]>>
>();

function selectionBoundsByPage(regions: PdfSelectionAnchor["regions"]) {
  const bounds = new Map<
    number,
    {
      left: number;
      top: number;
      right: number;
      bottom: number;
      lineHeight: number;
    }
  >();
  if (!validPdfCommentRegions(regions)) return bounds;
  for (const { page, x, y, width, height } of regions) {
    const box = bounds.get(page);
    bounds.set(page, {
      left: Math.min(box?.left ?? x, x),
      top: Math.min(box?.top ?? y, y),
      right: Math.max(box?.right ?? x + width, x + width),
      bottom: Math.max(box?.bottom ?? y + height, y + height),
      lineHeight: Math.max(box?.lineHeight ?? height, height),
    });
  }
  return bounds;
}

export async function recoverPdfSelectionCommentRanges(
  comments: InlineEditorComment[],
  selection: PdfSelectionAnchor,
): Promise<ReadonlyMap<PdfCommentAnchor, PdfTextRange[]>> {
  const { source } = selection;
  let cache = recoveredBySource.get(source);
  if (!cache) {
    cache = new Map();
    recoveredBySource.set(source, cache);
  }
  const selectedPages = new Set(selection.ranges.map(({ page }) => page));
  let selectionBounds: ReturnType<typeof selectionBoundsByPage> | undefined;
  const pageText = new Map<number, Promise<StructuredTextData>>();
  const getPageText = (page: number) => {
    let request = pageText.get(page);
    if (!request) {
      request = getOrOpenDocument(source).then(({ docId }) =>
        getMupdfClient().getPageText(docId, page - 1),
      );
      pageText.set(page, request);
    }
    return request;
  };
  const recovered = new Map<PdfCommentAnchor, PdfTextRange[]>();
  await Promise.all(
    comments.map(async ({ pdf, resolved, text }) => {
      if (
        resolved ||
        !text.trim() ||
        pdf?.fingerprint !== selection.fingerprint ||
        !validPdfCommentRegions(pdf.regions) ||
        !pdf.regions.some(({ page }) => selectedPages.has(page))
      )
        return;

      const key = JSON.stringify([pdf.text, pdf.regions]);
      let request = cache.get(key);
      if (!request) {
        const bounds = (selectionBounds ??= selectionBoundsByPage(
          selection.regions,
        ));
        const nearby = pdf.regions.some(({ page, x, y, width, height }) => {
          if (!selectedPages.has(page)) return false;
          const box = bounds.get(page);
          if (!box) return true;
          // Allow a line's worth of slack for differences in glyph metrics.
          const padding = Math.max(box.lineHeight, height);
          return (
            x <= box.right + padding &&
            x + width >= box.left - padding &&
            y <= box.bottom + padding &&
            y + height >= box.top - padding
          );
        });
        if (!nearby) return;

        const pages = [...new Set(pdf.regions.map(({ page }) => page))];
        request = Promise.all(
          pages.map(async (page) => [page, await getPageText(page)] as const),
        ).then((entries) => recoverPdfCommentRanges(pdf, new Map(entries)));
        cache.set(key, request);
      }
      try {
        recovered.set(pdf, await request);
      } catch {
        if (cache.get(key) === request) cache.delete(key);
      }
    }),
  );
  return recovered;
}
