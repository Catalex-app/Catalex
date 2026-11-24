import { type RefObject, useEffect, useRef, useState } from "react";
import { captureCompileContext } from "@/lib/workspace-compile";
import { useDocumentStore } from "@/stores/document-store";
import { highlightEditorPosition } from "./editor/editor-navigation";
import type {
  PdfReadingAnchor,
  PdfReadingAnchorControl,
} from "./preview/pdf-reading-anchor";
import {
  lookupPdfSource,
  lookupSourceInPdf,
  revealPdfSource,
} from "./preview/pdf-preview";
import {
  editorReadingPosition,
  editorViewInPanel,
  editorViewportCenter,
  highlightMarkdownPosition,
  markdownFrame,
  readEditorScroll,
  readMarkdownPosition,
  readPdfPosition,
  restoreEditorPosition,
  restoreMarkdownPosition,
  restorePdfPosition,
  type EditorScrollPosition,
  type MarkdownReadingPosition,
} from "./reading-position";
import type { WorkspaceContentMode } from "./workspace-layout-state";

type Positions = {
  editor?: EditorScrollPosition;
  markdown?: MarkdownReadingPosition;
  pdf?: PdfReadingAnchor;
};

type Switch = {
  mode: WorkspaceContentMode;
  fileId: string;
  highlight?: number | PdfReadingAnchor;
};

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export function useFullChatReadingPosition({
  enabled,
  mode,
  visible,
  animating,
  fileId,
  markdown,
  editor,
  preview,
  pdf,
  paneWidth,
  selectMode,
  clearSyncTargets,
}: {
  enabled: boolean;
  mode: WorkspaceContentMode;
  visible: boolean;
  animating: boolean;
  fileId: string;
  markdown: boolean;
  editor: RefObject<HTMLElement | null>;
  preview: RefObject<HTMLElement | null>;
  pdf: RefObject<PdfReadingAnchorControl | null>;
  paneWidth: (side: WorkspaceContentMode) => number;
  selectMode: (mode: WorkspaceContentMode, fileId?: string) => void;
  clearSyncTargets: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "preparing" | "opening">("idle");
  const pending = useRef<Switch | null>(null);
  const saved = useRef(new Map<string, Positions>());
  const arrival = useRef<{ fileId: string; positions: Positions } | undefined>(
    undefined,
  );
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const read = (side: WorkspaceContentMode): Positions => {
    if (side === "editor")
      return { editor: readEditorScroll(editor.current, true) };
    const frame = markdown ? markdownFrame(preview.current) : null;
    return markdown
      ? { markdown: frame ? readMarkdownPosition(frame) : undefined }
      : { pdf: readPdfPosition(pdf.current) };
  };

  const finish = () => {
    if (editor.current) editor.current.style.visibility = "";
    clearSyncTargets();
    pending.current = null;
    setPhase("idle");
  };

  useEffect(() => {
    if (enabled && pending.current?.fileId === fileId) return;
    pending.current = null;
    setPhase("idle");
    arrival.current = undefined;
    if (!enabled) saved.current.clear();
    if (editor.current) {
      editor.current.style.width = "";
      editor.current.style.visibility = "";
    }
    if (preview.current) preview.current.style.width = "";
  }, [enabled, fileId, editor, preview]);

  useEffect(() => {
    const request = pending.current;
    if (
      phase !== "opening" ||
      !request ||
      !visible ||
      animating ||
      request.mode !== mode
    )
      return;
    let frame = 0;
    const settle = () => {
      if (pending.current !== request) return;
      if (mode === "pdf" && !markdown && pdf.current?.preserving()) {
        frame = requestAnimationFrame(settle);
        return;
      }
      const editorPanel = editor.current;
      const highlight = request.highlight;
      if (mode === "editor" && editorPanel) {
        const view = editorViewInPanel(editorPanel);
        editorPanel.style.width = "";
        if (view)
          highlightEditorPosition(
            view,
            typeof highlight === "number"
              ? highlight
              : editorViewportCenter(view),
          );
      } else if (markdown) {
        if (preview.current) preview.current.style.width = "";
        const frameDocument = markdownFrame(preview.current);
        if (frameDocument)
          highlightMarkdownPosition(
            frameDocument,
            typeof highlight === "number" ? highlight : undefined,
          );
      } else {
        const point =
          typeof highlight === "object"
            ? highlight
            : readPdfPosition(pdf.current);
        if (point) pdf.current?.highlight(point);
      }
      arrival.current = { fileId, positions: read(mode) };
      finish();
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  });

  const switchTo = async (next: WorkspaceContentMode) => {
    if (!enabled) {
      selectMode(next);
      return;
    }
    if (pending.current?.mode === next) return;
    if (next === mode) {
      if (pending.current) {
        const pane = mode === "editor" ? editor.current : preview.current;
        if (pane) pane.style.width = "";
        finish();
      }
      return;
    }

    if (editor.current) editor.current.style.visibility = "";
    const request: Switch = { mode: next, fileId };
    pending.current = request;
    setPhase("preparing");
    clearSyncTargets();
    const previous = saved.current.get(fileId) ?? {};
    const outgoing = read(mode);
    const arrived =
      arrival.current?.fileId === fileId ? arrival.current.positions : previous;
    const arrivedPdf = arrived.pdf;
    const outgoingPdf = outgoing.pdf;
    const moved =
      (outgoing.editor &&
        outgoing.editor.scrollTop !== arrived.editor?.scrollTop) ||
      (outgoing.markdown &&
        (outgoing.markdown.position !== arrived.markdown?.position ||
          Math.abs(outgoing.markdown.topOffset - arrived.markdown.topOffset) >
            0.5)) ||
      (outgoingPdf &&
        (!arrivedPdf ||
          outgoingPdf.page !== arrivedPdf.page ||
          Math.abs(outgoingPdf.pdfX - arrivedPdf.pdfX) > 0.5 ||
          Math.abs(outgoingPdf.pdfY - arrivedPdf.pdfY) > 0.5));
    saved.current.set(fileId, { ...previous, ...outgoing });
    const state = useDocumentStore.getState();
    const currentFile = state.files.find((file) => file.id === fileId);
    let fileSelectionRevision = state.fileSelectionRevision;
    const stillCurrent = () =>
      pending.current === request &&
      enabledRef.current &&
      useDocumentStore.getState().fileSelectionRevision ===
        fileSelectionRevision &&
      useDocumentStore.getState().projectRoot === state.projectRoot;
    const compileCurrent = captureCompileContext();
    const samePdf = () =>
      compileCurrent() &&
      state.pdfRevision === useDocumentStore.getState().pdfRevision;
    const editorPanel = editor.current;
    if (editorPanel)
      editorPanel.style.width = `${mode === "editor" ? editorPanel.clientWidth : paneWidth("editor")}px`;

    if (markdown && preview.current) {
      const width =
        mode === "pdf" ? preview.current.clientWidth : paneWidth("pdf");
      preview.current.style.width = `${width}px`;
    }
    if (next === "editor") {
      let position: EditorScrollPosition | number | undefined = moved
        ? undefined
        : previous.editor;
      if (position === undefined && markdown)
        position = outgoing.markdown?.position;
      else if (position === undefined && outgoingPdf && state.projectRoot) {
        const result = await lookupPdfSource(
          state.projectRoot,
          outgoingPdf.page,
          outgoingPdf.pdfX,
          outgoingPdf.pdfY,
        );
        if (!stillCurrent()) return;
        const source =
          result && samePdf() ? revealPdfSource(result) : undefined;
        position = source?.position;
        if (source?.needsSwitch) {
          request.fileId = source.fileId;
          fileSelectionRevision =
            useDocumentStore.getState().fileSelectionRevision;
          await nextFrame();
        }
      }
      if (!stillCurrent()) return;
      const view = editorViewInPanel(editor.current);
      if (view && position !== undefined) {
        if (typeof position === "number") request.highlight = position;
        // The first visible measurement replaces the clipped editor's height estimates.
        if (
          editorPanel &&
          typeof position === "number" &&
          !saved.current.get(request.fileId)?.editor
        )
          editorPanel.style.visibility = "hidden";
        else restoreEditorPosition(view, position);
      }
    } else {
      const view = editorViewInPanel(editor.current);
      const cursor = state.selectionRange?.start ?? state.cursorPosition;
      const position = view ? editorReadingPosition(view, cursor) : cursor;
      if (markdown) {
        await nextFrame();
        if (!stillCurrent()) return;
        const frame = markdownFrame(preview.current);
        const target =
          !moved && previous.markdown ? previous.markdown : position;
        if (frame) restoreMarkdownPosition(frame, target);
        if (typeof target === "number") request.highlight = target;
      } else {
        let point = moved ? undefined : previous.pdf;
        if (!point && state.projectRoot && currentFile?.type === "tex") {
          const result = await lookupSourceInPdf(
            state.projectRoot,
            currentFile,
            position,
          );
          if (!stillCurrent()) return;
          if (samePdf()) point = result;
        }
        if (point) restorePdfPosition(pdf.current, point);
        request.highlight = point;
      }
    }
    const coldEditor =
      editorPanel?.style.visibility === "hidden" &&
      editorViewInPanel(editorPanel);
    if (!coldEditor) {
      // Let the existing placement settle before starting the slide.
      await nextFrame();
      await nextFrame();
    }
    if (!stillCurrent()) return;
    selectMode(next, request.fileId);
    if (coldEditor && typeof request.highlight === "number") {
      const measured = () =>
        new Promise<boolean>((resolve) =>
          coldEditor.requestMeasure({
            read: () => coldEditor.inView,
            write: resolve,
          }),
        );
      // Place the source as soon as CodeMirror measures the opening pane.
      while (stillCurrent() && !(await measured())) {}
      if (!stillCurrent()) return;
      restoreEditorPosition(coldEditor, request.highlight);
      await measured();
      if (!stillCurrent()) return;
    }
    editorPanel?.style.removeProperty("visibility");
    setPhase("opening");
  };

  return {
    switchTo,
    switching: phase !== "idle",
    muted: () => pending.current !== null,
  };
}
