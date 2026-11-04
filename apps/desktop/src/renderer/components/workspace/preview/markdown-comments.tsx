import { canHandleEscape, consumeKey } from "@/lib/keyboard-events";
import { getActiveComment, setActiveComment } from "../editor/active-comment";
import type { CommentRange } from "../editor/comment-range";
import { attachCommentToChat } from "@/lib/comment-chat-context";
import { registerSelectionContextActions } from "@/lib/context-menu";
import { createPortal } from "react-dom";
import { CommentsPanel, CommentsSummaryButton } from "../editor/comments-panel";
import { ProblemsMotion } from "../editor/problems-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquareTextIcon } from "lucide-react";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { PDF_COMMENT_NAVIGATE_EVENT } from "@/lib/workspace-events";
import type {
  InlineEditorComment,
  InlineCommentActions,
} from "../editor/inline-comments";
import { SelectionToolbar } from "../editor/selection-toolbar";
import { useProjectComments } from "../editor/use-project-comments";
import { setCommentDraft } from "../editor/comment-draft-history";
import {
  markdownSelectionRange,
  markdownTextOffsets,
} from "./markdown-comment-source";
import {
  PdfCommentInteraction,
  PreviewCommentLayer,
  pdfCommentTargets,
  type PreviewCommentRegion,
  type PdfCommentTarget,
} from "./pdf-comments";

const emptyLookup = async () => [];

/** Markdown supplies source geometry; the PDF preview owns all comment UI. */
export function MarkdownComments({
  frameDocument,
  source,
  filePath,
  editorVisible,
  layoutAnimating,
  toolbarHost,
  panelHost,
}: {
  frameDocument: Document;
  source: string;
  filePath: string;
  editorVisible: boolean;
  layoutAnimating: boolean;
  toolbarHost: HTMLDivElement | null;
  panelHost: HTMLDivElement | null;
}) {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const selectedCommentIdsJson = useAgentChatStore((state) =>
    JSON.stringify(
      state.tabs
        .find((tab) => tab.id === state.activeTabId)
        ?.draft.pinnedContexts.filter(
          (context) => context.comment && context.filePath === filePath,
        )
        .map((context) => context.comment!.id) ?? [],
    ),
  );
  const selectedCommentIds = useMemo<string[]>(
    () => JSON.parse(selectedCommentIdsJson),
    [selectedCommentIdsJson],
  );
  const agentWorkspaceRoot = useDocumentStore((s) => s.agentWorkspaceRoot);
  const projectFiles = useDocumentStore((s) => s.files);
  const visible = useSettingsStore(
    (s) => s.displayComments && s.showPdfComments,
  );
  const [files, setFiles, , commentsLoaded] = useProjectComments(
    agentWorkspaceRoot ? null : projectRoot,
  );
  const [selection, setSelection] = useState<{
    range: Range;
    sourceRange: ReturnType<typeof markdownSelectionRange>;
  } | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [requestedCommentId, setRequestedCommentId] = useState<string | null>(
    null,
  );
  const [requestRevision, setRequestRevision] = useState(0);
  const panelsProjectKey = JSON.stringify(projectRoot);
  const panelOpen = useSettingsStore(
    (s) => s.editorCommentsPanelOpenByProject[panelsProjectKey] ?? false,
  );
  const filter = useSettingsStore(
    (s) => s.editorCommentFilterByProject[panelsProjectKey] ?? "all",
  );
  const savePanelOpen = useSettingsStore((s) => s.setEditorCommentsPanelOpen);
  const saveFilter = useSettingsStore((s) => s.setEditorCommentFilter);
  const activeComments = (files[filePath] ?? []).filter(
    (comment) => !comment.resolved,
  );
  const showControls = !editorVisible && activeComments.length > 0;
  const pageElement = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<{
    width: number;
    pageLeft: number;
    pageWidth: number;
    height: number;
    scrollTop: number;
    scrollLeft: number;
    regions: PreviewCommentRegion[];
    links: { x: number; y: number; w: number; h: number }[];
  }>({
    width: 1,
    pageLeft: 0,
    pageWidth: 1,
    height: 1,
    scrollTop: 0,
    scrollLeft: 0,
    regions: [],
    links: [],
  });
  const [rangePreview, setRangePreview] = useState<{
    target: PdfCommentTarget;
    range: CommentRange;
  } | null>(null);
  const targets = useMemo(
    () =>
      pdfCommentTargets(projectFiles, files).filter(
        (target) => target.filePath === filePath,
      ),
    [projectFiles, files, filePath],
  );
  const navigate = useCallback(
    (target: PdfCommentTarget) => {
      setSelection(null);
      window.dispatchEvent(
        new CustomEvent(PDF_COMMENT_NAVIGATE_EVENT, {
          detail: {
            projectRoot,
            filePath: target.filePath,
            commentId: target.comment.id,
          },
        }),
      );
    },
    [projectRoot],
  );
  const context = useMemo(
    () =>
      visible && projectRoot && !agentWorkspaceRoot
        ? {
            targets,
            lookup: emptyLookup,
            navigate,
            selectionEnabled: true,
            clearSelection: () => {
              const store = useDocumentStore.getState();
              if (store.commentSelectionContext)
                store.setCommentSelectionContext(null);
            },
          }
        : null,
    [visible, projectRoot, agentWorkspaceRoot, targets, navigate],
  );

  useEffect(() => {
    setSelection(null);
    setRequestedCommentId(null);
  }, [source, filePath]);
  useEffect(() => {
    const update = () => {
      const selected = frameDocument.getSelection();
      setSelection(
        selected &&
          !selected.isCollapsed &&
          selected.rangeCount &&
          selected.toString().trim()
          ? {
              range: selected.getRangeAt(0).cloneRange(),
              sourceRange: markdownSelectionRange(selected, source),
            }
          : null,
      );
    };
    const click = (event: MouseEvent) => {
      if (
        event.detail > 1 ||
        !frameDocument.getSelection()?.isCollapsed ||
        (event.target as Element).closest?.("a, button")
      )
        return;
      const frame =
        frameDocument.defaultView?.frameElement?.getBoundingClientRect();
      if (!frame) return;
      const x = event.clientX + frame.left;
      const y = event.clientY + frame.top;
      const hit = [
        ...(pageElement.current?.querySelectorAll<HTMLButtonElement>(
          "[data-pdf-comment-highlight]",
        ) ?? []),
      ]
        .reverse()
        .find((el) => {
          const rect = el.getBoundingClientRect();
          return (
            x >= rect.left &&
            x <= rect.right &&
            y >= rect.top &&
            y <= rect.bottom
          );
        });
      if (hit) hit.click();
      else pageElement.current?.click();
    };
    const key = (event: KeyboardEvent) => {
      if (
        !event.isComposing &&
        !event.altKey &&
        (event.metaKey || event.ctrlKey) &&
        (event.key.toLowerCase() === "z" ||
          (event.ctrlKey && event.key.toLowerCase() === "y"))
      ) {
        const request = new CustomEvent("catalex-file-undo", {
          cancelable: true,
          detail: {
            root: projectRoot,
            filePath,
            redo: event.shiftKey || event.key.toLowerCase() === "y",
          },
        });
        window.dispatchEvent(request);
        if (request.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
        }
      }
      if (
        canHandleEscape(event) &&
        (selectionRef.current || getActiveComment())
      ) {
        consumeKey(event);
        if (selectionRef.current)
          frameDocument.getSelection()?.removeAllRanges();
        setSelection(null);
        setActiveComment(null);
      }
    };
    frameDocument.addEventListener("selectionchange", update);
    frameDocument.addEventListener("click", click);
    frameDocument.addEventListener("keydown", key);
    return () => {
      frameDocument.removeEventListener("selectionchange", update);
      frameDocument.removeEventListener("click", click);
      frameDocument.removeEventListener("keydown", key);
    };
  }, [frameDocument, source]);

  useEffect(() => {
    const update = () => {
      const scroll = frameDocument.scrollingElement;
      const scrollTop = scroll?.scrollTop ?? 0;
      const scrollLeft = scroll?.scrollLeft ?? 0;
      const spans = [
        ...frameDocument.querySelectorAll<HTMLElement>("[data-comment-start]"),
      ];
      const writeBounds = frameDocument
        .getElementById("write")!
        .getBoundingClientRect();
      const pageLeft = writeBounds.left + scrollLeft;
      const regions: PreviewCommentRegion[] = [];
      for (const original of targets) {
        const target =
          rangePreview?.target.comment.id === original.comment.id
            ? {
                ...original,
                comment: { ...original.comment, ...rangePreview.range },
              }
            : original;
        const comment = target.comment;
        const targetRanges: PreviewCommentRegion["ranges"][number][] = [];
        for (const span of spans) {
          const from = Number(span.dataset.commentStart);
          const to = Number(span.dataset.commentEnd);
          if (to <= comment.from || from >= comment.to || !span.firstChild)
            continue;
          const offsets = markdownTextOffsets(span, source);
          if (!offsets) continue;
          const start = Math.max(
            0,
            offsets.findIndex((offset) => offset >= comment.from),
          );
          const end = offsets.findIndex((offset) => offset >= comment.to);
          const range = frameDocument.createRange();
          range.setStart(span.firstChild, start);
          range.setEnd(span.firstChild, end < 0 ? offsets.length - 1 : end);
          for (const rect of range.getClientRects()) {
            if (!rect.width || !rect.height) continue;
            const bounds = {
              x: rect.left + scrollLeft - pageLeft,
              y: rect.top + scrollTop,
              w: rect.width,
              h: rect.height,
            };
            const region = regions.find(
              (r) =>
                Math.abs(r.bounds.y - bounds.y) < 1 &&
                Math.abs(r.bounds.h - bounds.h) < 1,
            );
            const highlight = {
              target,
              x: bounds.x,
              width: bounds.w,
              start: false,
              end: false,
            };
            targetRanges.push(highlight);
            if (region) {
              region.bounds.w =
                Math.max(
                  region.bounds.x + region.bounds.w,
                  bounds.x + bounds.w,
                ) - Math.min(region.bounds.x, bounds.x);
              region.bounds.x = Math.min(region.bounds.x, bounds.x);
              region.ranges.push(highlight);
            } else
              regions.push({
                bounds,
                ranges: [highlight],
              });
          }
        }
        if (targetRanges.length) {
          targetRanges[0].start = true;
          targetRanges[targetRanges.length - 1].end = true;
        }
      }
      const links = [...frameDocument.querySelectorAll("a")].flatMap((link) =>
        [...link.getClientRects()].map((rect) => ({
          x: rect.left + scrollLeft - pageLeft,
          y: rect.top + scrollTop,
          w: rect.width,
          h: rect.height,
        })),
      );
      setGeometry({
        pageLeft,
        pageWidth: writeBounds.width,
        width: Math.max(1, frameDocument.documentElement.clientWidth),
        height: Math.max(1, scroll?.scrollHeight ?? 1),
        scrollTop,
        scrollLeft,
        regions,
        links,
      });
    };
    let pending = 0;
    const schedule = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(update);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(frameDocument.documentElement);
    observer.observe(frameDocument.body);
    const mutations = new MutationObserver(schedule);
    mutations.observe(frameDocument.getElementById("write")!, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    frameDocument.addEventListener("scroll", schedule, true);
    frameDocument.defaultView?.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(pending);
      observer.disconnect();
      mutations.disconnect();
      frameDocument.removeEventListener("scroll", schedule, true);
      frameDocument.defaultView?.removeEventListener("resize", schedule);
    };
  }, [targets, frameDocument, source, rangePreview]);

  const actionsFor = useCallback(
    (target: PdfCommentTarget): InlineCommentActions => {
      const update = (
        change: (c: InlineEditorComment) => InlineEditorComment | null,
      ) =>
        setFiles((current) => ({
          ...current,
          [filePath]: (current[filePath] ?? []).flatMap((c) => {
            if (c.id !== target.comment.id) return [c];
            const next = change(c);
            return next ? [next] : [];
          }),
        }));
      return {
        historyScope: projectRoot ? { root: projectRoot, filePath } : undefined,
        selectedCommentIds,
        onAttach: (comment) =>
          attachCommentToChat(projectRoot, filePath, comment),
        onResize: (id, range) =>
          setFiles(
            (current) => ({
              ...current,
              [filePath]: (current[filePath] ?? []).map((comment) =>
                comment.id === id
                  ? {
                      ...comment,
                      ...range,
                      positionReset: false,
                      removedAnchor: undefined,
                    }
                  : comment,
              ),
            }),
            true,
          ),
        onSave: (_id, text) => {
          if (text.trim()) update((c) => ({ ...c, text, isEditing: false }));
        },
        onEdit: () => update((c) => ({ ...c, isEditing: true })),
        onCancel: () =>
          update((c) => (c.text.trim() ? { ...c, isEditing: false } : null)),
        onResolve: () => update((c) => ({ ...c, resolved: true })),
        onDelete: () => update(() => null),
      };
    },
    [filePath, setFiles, projectRoot, selectedCommentIds],
  );
  const getAnchor = useCallback(() => {
    const frame =
      frameDocument.defaultView?.frameElement?.getBoundingClientRect();
    const rect = selection?.range.getBoundingClientRect();
    if (!frame || !rect || rect.bottom <= 0 || rect.top >= frame.height)
      return null;
    return {
      top: frame.top + rect.top,
      left: frame.left + rect.left - 50,
      bounds: {
        top: Math.max(0, frame.top) + 8,
        bottom: Math.min(window.innerHeight, frame.bottom) - 8,
        left: Math.max(0, frame.left) + 8,
        right: Math.min(window.innerWidth, frame.right) - 8,
      },
    };
  }, [frameDocument, selection]);
  const dismiss = useCallback(() => setSelection(null), []);
  const addComment = (
    sourceRange: ReturnType<typeof markdownSelectionRange>,
  ) => {
    if (!sourceRange || !commentsLoaded) return;
    const id = crypto.randomUUID();
    const draftComment = {
      id,
      ...sourceRange,
      text: "",
      createdAt: new Date().toISOString(),
      isEditing: true,
    };
    setFiles((current) => ({
      ...current,
      [filePath]: [
        ...(current[filePath] ?? []).filter(
          (c) => c.text.trim() || !c.isEditing,
        ),
        draftComment,
      ],
    }));
    if (projectRoot)
      setCommentDraft({ root: projectRoot, filePath }, id, {
        comment: draftComment,
        text: "",
      });
    setRequestRevision(0);
    setRequestedCommentId(id);
    frameDocument.getSelection()?.removeAllRanges();
    setSelection(null);
  };
  useEffect(
    () =>
      registerSelectionContextActions(frameDocument.body, () => {
        if (!context) return [];
        const selected = frameDocument.getSelection();
        const sourceRange = selected
          ? markdownSelectionRange(selected, source)
          : null;
        return [
          {
            label: "Add Comment",
            disabled: !sourceRange || !commentsLoaded,
            run: () => addComment(sourceRange),
          },
        ];
      }),
    [frameDocument, context, source, filePath, setFiles, commentsLoaded],
  );
  if (!context) return null;
  return (
    <>
      {toolbarHost &&
        createPortal(
          <ProblemsMotion kind="button" open={showControls && !panelOpen}>
            <div
              data-pdf-comments-summary
              className="flex shrink-0 items-center"
            >
              <div
                aria-hidden="true"
                className="mx-1 h-4 w-px shrink-0 bg-border"
              />
              <CommentsSummaryButton
                comments={activeComments}
                onOpen={() => savePanelOpen(panelsProjectKey, true)}
              />
            </div>
          </ProblemsMotion>,
          toolbarHost,
        )}
      {panelHost &&
        createPortal(
          <ProblemsMotion kind="bar" open={showControls && panelOpen}>
            <CommentsPanel
              comments={activeComments}
              filter={filter}
              onFilter={(value) => saveFilter(panelsProjectKey, value)}
              onClose={() => savePanelOpen(panelsProjectKey, false)}
              onNavigate={(comment) => {
                if (!comment.isEditing)
                  attachCommentToChat(projectRoot, filePath, comment);
                setRequestedCommentId(comment.id);
                setRequestRevision((value) => value + 1);
              }}
            />
          </ProblemsMotion>,
          panelHost,
        )}
      <div
        className="pointer-events-none absolute inset-0 overflow-clip"
        data-testid="markdown-comments"
      >
        <PdfCommentInteraction
          context={context}
          scrollElement={frameDocument.scrollingElement}
          editorVisible={editorVisible}
          layoutAnimating={layoutAnimating}
          actionsFor={actionsFor}
          requestedCommentId={requestedCommentId}
          requestRevision={requestRevision}
          centerRequested={requestRevision > 0}
        >
          <div className="absolute inset-0" data-testid="pdf-scroll-container">
            <div
              className="absolute top-0 left-0"
              data-pdf-scroll-content
              style={{
                width: geometry.width,
                height: geometry.height,
                transform: `translate(${-geometry.scrollLeft}px, ${-geometry.scrollTop}px)`,
              }}
            >
              <div
                style={{ left: geometry.pageLeft, width: geometry.pageWidth }}
                ref={pageElement}
                className="absolute inset-0"
                data-page-number="1"
              >
                <PreviewCommentLayer
                  regions={geometry.regions}
                  onPreview={setRangePreview}
                  offsetAtPoint={(_target, x, y) => {
                    const frame =
                      frameDocument.defaultView?.frameElement?.getBoundingClientRect();
                    if (!frame) return null;
                    const caretDocument = frameDocument as Document & {
                      caretRangeFromPoint(x: number, y: number): Range | null;
                    };
                    const caret = caretDocument.caretRangeFromPoint(
                      x - frame.left,
                      y - frame.top,
                    );
                    const element =
                      caret?.startContainer.parentElement?.closest<HTMLElement>(
                        "[data-comment-start]",
                      );
                    if (!caret || !element) return null;
                    const offsets = markdownTextOffsets(element, source);
                    if (!offsets) return null;
                    const prefix = frameDocument.createRange();
                    prefix.selectNodeContents(element);
                    prefix.setEnd(caret.startContainer, caret.startOffset);
                    return offsets[prefix.toString().length] ?? null;
                  }}
                  pageNumber={1}
                  pageWidth={geometry.pageWidth}
                  pageHeight={geometry.height}
                  pageElement={pageElement}
                  links={geometry.links}
                />
              </div>
            </div>
          </div>
        </PdfCommentInteraction>
      </div>
      {selection && (
        <SelectionToolbar
          position={{ top: 0, left: 0 }}
          getAnchor={getAnchor}
          contextLabel="Markdown selection"
          actions={[
            {
              id: "comment",
              isAI: false,
              label: "Comment",
              icon: <MessageSquareTextIcon className="size-4" />,
              disabled: !selection.sourceRange || !commentsLoaded,
              description: selection.sourceRange
                ? "Add comment"
                : "Couldn’t locate the source. Select more surrounding text.",
            },
          ]}
          onDismiss={dismiss}
          onAction={() => addComment(selection.sourceRange)}
        />
      )}
    </>
  );
}
