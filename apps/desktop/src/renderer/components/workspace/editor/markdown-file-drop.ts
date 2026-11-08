import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { EditorView, layer, RectangleMarker } from "@codemirror/view";
import { isMarkdownFile, markdownFileLink } from "@/lib/markdown";
import { useDocumentStore } from "@/stores/document-store";

type DropPoint = { x: number; y: number };
const setDropPosition = StateEffect.define<number | null>();
const dropPosition = StateField.define<number | null>({
  create: () => null,
  update(position, transaction) {
    if (position !== null) position = transaction.changes.mapPos(position);
    for (const effect of transaction.effects) {
      if (effect.is(setDropPosition)) position = effect.value;
    }
    return position;
  },
});
let caretView: EditorView | null = null;

function markdownDropTarget(point: DropPoint) {
  const element = document
    .elementFromPoint(point.x, point.y)
    ?.closest(".cm-editor");
  const view = element ? EditorView.findFromDOM(element as HTMLElement) : null;
  if (
    !view ||
    !view.dom.hasAttribute("data-markdown-file-drop") ||
    view.state.readOnly
  )
    return null;
  const position = view.posAtCoords(point);
  return position === null ? null : { view, position };
}

export function updateMarkdownFileDropCaret(point: DropPoint | null) {
  const target = point ? markdownDropTarget(point) : null;
  if (caretView && caretView !== target?.view) {
    if (caretView.dom.isConnected)
      caretView.dispatch({ effects: setDropPosition.of(null) });
    caretView = null;
  }
  if (!target) return false;
  const changedView = caretView !== target.view;
  caretView = target.view;
  if (changedView || target.view.state.field(dropPosition) !== target.position)
    target.view.dispatch({ effects: setDropPosition.of(target.position) });
  return true;
}

export function insertMarkdownFileLinksAtPoint(
  paths: string[],
  point: DropPoint,
): boolean {
  updateMarkdownFileDropCaret(null);
  const target = markdownDropTarget(point);
  if (!target) return false;
  const { view, position: from } = target;
  const state = useDocumentStore.getState();
  const source = state.files.find((file) => file.id === state.activeFileId);
  if (!source || !isMarkdownFile(source)) return false;
  const links = paths
    .map((path) => markdownFileLink(source.absolutePath, path))
    .filter((link): link is string => link !== null);
  if (!links.length) return false;
  const insert = links.join("\n");
  view.dispatch({
    changes: { from, insert },
    selection: { anchor: from + insert.length },
    userEvent: "input.drop",
  });
  view.focus();
  return true;
}

export const markdownFileDrop = [
  dropPosition,
  layer({
    above: true,
    markers(view) {
      const position = view.state.field(dropPosition);
      return caretView !== view || position === null || view.state.readOnly
        ? []
        : RectangleMarker.forRange(
            view,
            "cm-dropCursor cm-markdown-file-drop-caret",
            EditorSelection.cursor(position),
          );
    },
    update: (update) =>
      update.geometryChanged ||
      update.docChanged ||
      update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setDropPosition)),
      ) ||
      update.startState.readOnly !== update.state.readOnly,
    destroy(_layer, view) {
      if (caretView === view) caretView = null;
    },
  }),
  EditorView.theme({
    ".cm-markdown-file-drop-caret": {
      borderLeftWidth: "2px",
      borderLeftColor: "var(--foreground)",
    },
  }),
  EditorView.editorAttributes.of({ "data-markdown-file-drop": "" }),
  EditorView.domEventHandlers({
    dragover(event) {
      if (!event.dataTransfer?.types.includes("Files")) return false;
      updateMarkdownFileDropCaret({ x: event.clientX, y: event.clientY });
      event.preventDefault();
      return true;
    },
    dragleave(event, view) {
      if (
        !(event.relatedTarget instanceof Node) ||
        !view.dom.contains(event.relatedTarget)
      )
        updateMarkdownFileDropCaret(null);
    },
    dragend() {
      updateMarkdownFileDropCaret(null);
    },
    drop(event) {
      updateMarkdownFileDropCaret(null);
      if (!event.dataTransfer?.files.length) return false;
      const paths = Array.from(
        event.dataTransfer.files,
        (file) => window.catalex?.getPathForFile(file) ?? "",
      ).filter(Boolean);
      if (
        !insertMarkdownFileLinksAtPoint(paths, {
          x: event.clientX,
          y: event.clientY,
        })
      )
        return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    },
  }),
];
