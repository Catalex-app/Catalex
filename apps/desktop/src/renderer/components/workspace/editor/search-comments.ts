import { useSettingsStore } from "@/stores/settings-store";
import { useMemo, useEffect, useId } from "react";
import { useDocumentStore } from "@/stores/document-store";
import {
  findPreviewMatches,
  findCommentIdMatches,
  type PreviewSearchQuery,
} from "@/lib/preview-search";
import { useProjectComments } from "./use-project-comments";
import {
  PDF_COMMENT_NAVIGATE_EVENT,
  COMMENT_SEARCH_NAVIGATE_EVENT,
} from "@/lib/workspace-events";
export function useSearchComments(
  query: PreviewSearchQuery,
  enabled: boolean,
  pdf: boolean,
  range?: { from: number; to: number } | null,
) {
  const root = useDocumentStore((s) => s.projectRoot);
  const isolated = useDocumentStore((s) => s.agentWorkspaceRoot);
  const activeFile = useDocumentStore((s) =>
    s.files.find((f) => f.id === s.activeFileId),
  );
  const [files] = useProjectComments(
    enabled && query.text && !isolated ? root : null,
  );
  const results = useMemo(() => {
    if (!enabled || !query.text) return [];
    try {
      return Object.entries(files).flatMap(([filePath, comments]) => {
        if (
          pdf
            ? !/\.(tex|bib|sty|cls)$/i.test(filePath)
            : filePath !== activeFile?.relativePath
        )
          return [];
        return comments
          .filter(
            (c) =>
              !c.resolved &&
              (!range || (c.from >= range.from && c.to <= range.to)),
          )
          .flatMap((comment) => {
            const label = `${comment.origin ? "A" : "H"}-${comment.number ?? comment.expectedNumber ?? 1}`;
            const idMatch = findCommentIdMatches(label, query)[0];
            const match = idMatch ?? findPreviewMatches(comment.text, query)[0];
            return match
              ? [
                  {
                    id: comment.id,
                    commentId: comment.id,
                    filePath,
                    text: idMatch ? `${label} · ${comment.text}` : comment.text,
                    match,
                  },
                ]
              : [];
          });
      });
    } catch {
      return [];
    }
  }, [
    files,
    enabled,
    query.text,
    query.caseSensitive,
    query.wholeWord,
    query.regex,
    activeFile?.relativePath,
    pdf,
    range,
  ]);
  const navigate = (index: number) => {
    const result = results[index];
    if (!result) return;
    const detail = {
      projectRoot: root,
      filePath: result.filePath,
      commentId: result.commentId,
    };
    useSettingsStore.getState().setDisplayComments(true);
    useSettingsStore.getState().setShowPdfComments(true);
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent(COMMENT_SEARCH_NAVIGATE_EVENT, { detail }),
      );
      window.dispatchEvent(
        new CustomEvent(PDF_COMMENT_NAVIGATE_EVENT, { detail }),
      );
    });
  };
  return { results, navigate };
}

// CSS highlights leave the comment card's editable DOM and undo history intact.
export function useCommentSearchHighlight(
  result: ReturnType<typeof useSearchComments>["results"][number] | undefined,
  query: PreviewSearchQuery,
) {
  const id = useId().replace(/[^a-z0-9]/gi, "");
  useEffect(() => {
    if (!result || !globalThis.CSS?.highlights || !globalThis.Highlight) return;
    const name = `comment-search-${id}`;
    const style = document.createElement("style");
    style.textContent = `::highlight(${name}) { background-color: #fff3a3; color: #171717; }`;
    document.head.append(style);
    let frame = 0;
    const update = () => {
      frame = 0;
      const ranges: Range[] = [];
      for (const card of document.querySelectorAll<HTMLElement>(
        `[data-inline-comment-id="${CSS.escape(result.commentId)}"]`,
      )) {
        for (const body of card.querySelectorAll(
          ".cm-inlineCommentText, .cm-inlineCommentBadge",
        )) {
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const matches = body.classList.contains("cm-inlineCommentBadge")
              ? findCommentIdMatches(node.textContent ?? "", query)
              : findPreviewMatches(node.textContent ?? "", query);
            for (const match of matches) {
              const range = document.createRange();
              range.setStart(node, match.start);
              range.setEnd(node, match.end);
              ranges.push(range);
            }
          }
        }
      }
      CSS.highlights.set(name, new Highlight(...ranges));
    };
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(update);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    update();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      style.remove();
      CSS.highlights.delete(name);
    };
  }, [
    result,
    id,
    query.text,
    query.caseSensitive,
    query.wholeWord,
    query.regex,
  ]);
}
