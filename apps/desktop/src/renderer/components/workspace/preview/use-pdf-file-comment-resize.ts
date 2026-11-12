import {
  pdfCommentPassageBetween,
  recoverPdfCommentRanges,
  type PdfTextPoint,
} from "@/lib/mupdf/pdf-comment-passage";
import { getOrOpenDocument } from "@/lib/mupdf/pdf-doc-cache";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import type { PdfSource } from "@/lib/mupdf/pdf-source";
import type { StructuredTextData } from "@/lib/mupdf/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommentRangeEdge } from "../editor/comment-range";
import type { PdfCommentAnchor } from "../editor/inline-comments";
import type { PdfCommentTarget } from "./pdf-comments";
import { validPdfCommentRegions } from "./pdf-file-comments";

export type ResizePdfComment = (
  target: PdfCommentTarget,
  anchor: PdfCommentAnchor,
) => void;

export function usePdfFileCommentResize(
  source: PdfSource | null,
  selected: PdfCommentTarget | null,
  onResize?: ResizePdfComment,
) {
  const anchor = selected?.comment.pdf;
  const cache = useMemo(
    () => ({
      pages: new Map<number, StructuredTextData>(),
      pending: new Map<number, Promise<void>>(),
    }),
    [source],
  );
  const loadPage = useCallback(
    (page: number) => {
      if (!source || cache.pages.has(page)) return Promise.resolve();
      let request = cache.pending.get(page);
      if (!request) {
        request = getOrOpenDocument(source)
          .then(({ docId }) => getMupdfClient().getPageText(docId, page - 1))
          .then((textData) => {
            cache.pages.set(page, textData);
          })
          .finally(() => cache.pending.delete(page));
        cache.pending.set(page, request);
      }
      return request;
    },
    [source, cache],
  );
  const [prepared, setPrepared] = useState<{
    source: PdfSource;
    anchor: PdfCommentAnchor;
    from: PdfTextPoint;
    to: PdfTextPoint;
  } | null>(null);
  const [preview, setPreview] = useState<{
    id: string;
    anchor: PdfCommentAnchor;
  } | null>(null);
  const [dragPage, setDragPage] = useState<number | null>(null);
  const drag = useRef<{
    target: PdfCommentTarget;
    edge: CommentRangeEdge;
    from: PdfTextPoint;
    to: PdfTextPoint;
    last?: PdfTextPoint;
    pending?: Promise<void>;
    next?: PdfCommentAnchor;
  } | null>(null);
  const resetDrag = () => {
    drag.current = null;
    setPreview(null);
    setDragPage(null);
  };

  useEffect(() => {
    resetDrag();
    setPrepared(null);
    if (!source || !anchor || !onResize) return;
    let cancelled = false;
    const pages = [...new Set(anchor.regions.map(({ page }) => page))];
    void Promise.all(pages.map(loadPage))
      .then(() => {
        if (cancelled) return;
        const ranges = recoverPdfCommentRanges(anchor, cache.pages);
        const first = ranges[0];
        const last = ranges[ranges.length - 1];
        if (first && last)
          setPrepared({
            source,
            anchor,
            from: { page: first.page, offset: first.from },
            to: { page: last.page, offset: last.to },
          });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      drag.current = null;
    };
  }, [source, anchor, onResize, loadPage, cache]);

  const ready = Boolean(
    prepared && prepared.source === source && prepared.anchor === anchor,
  );

  return {
    ready,
    preview,
    dragPage,
    start(target: PdfCommentTarget, edge: CommentRangeEdge, page: number) {
      if (!ready || !prepared || target.comment.pdf !== prepared.anchor) return;
      drag.current = { target, edge, from: prepared.from, to: prepared.to };
      setDragPage(page);
    },
    move(point: PdfTextPoint) {
      const current = drag.current;
      if (
        !current ||
        (current.last?.page === point.page &&
          current.last.offset === point.offset)
      )
        return;
      current.last = point;
      current.pending = undefined;
      const fixed = current.edge === "from" ? current.to : current.from;
      const start = current.edge === "from" ? point : fixed;
      const end = current.edge === "to" ? point : fixed;
      if (
        start.page > end.page ||
        (start.page === end.page && start.offset >= end.offset)
      )
        return;
      const original = current[current.edge];
      if (point.page === original.page && point.offset === original.offset) {
        current.next = undefined;
        setPreview(null);
        return;
      }

      const update = () => {
        if (drag.current !== current || current.last !== point) return;
        const passage = pdfCommentPassageBetween(cache.pages, start, end);
        if (
          !passage ||
          !validPdfCommentRegions(passage.regions) ||
          new TextEncoder().encode(passage.text).length > 80_000
        )
          return;
        current.next = {
          ...passage,
          fingerprint: current.target.comment.pdf!.fingerprint,
        };
        setPreview({ id: current.target.comment.id, anchor: current.next });
      };
      const missing: Promise<void>[] = [];
      for (let page = start.page; page <= end.page; page++) {
        if (!cache.pages.has(page)) missing.push(loadPage(page));
      }
      if (missing.length)
        current.pending = Promise.all(missing)
          .then(update)
          .catch(() => {});
      else update();
    },
    finish(commit: boolean) {
      const current = drag.current;
      if (!current) return;
      const finish = () => {
        if (drag.current !== current) return;
        resetDrag();
        if (commit && current.next) onResize?.(current.target, current.next);
      };
      if (commit && current.pending) void current.pending.then(finish);
      else finish();
    },
  };
}
