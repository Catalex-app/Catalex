import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

function selectionTextFromState(state: EditorState): string | null {
  const ranges = state.selection.ranges.filter((range) => !range.empty);
  if (ranges.length === 0) return null;

  return ranges
    .map((range) => state.sliceDoc(range.from, range.to))
    .join(state.lineBreak);
}

function selectionTextFromDom(view: EditorView): string | null {
  const root = view.root as DocumentOrShadowRoot & {
    getSelection?: () => Selection | null;
  };
  const selection = root.getSelection?.() ?? document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const ranges: Array<{ from: number; to: number }> = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (
      range.collapsed ||
      !view.contentDOM.contains(range.startContainer) ||
      !view.contentDOM.contains(range.endContainer)
    ) {
      continue;
    }

    try {
      const anchor = view.posAtDOM(range.startContainer, range.startOffset);
      const head = view.posAtDOM(range.endContainer, range.endOffset);
      const from = Math.min(anchor, head);
      const to = Math.max(anchor, head);
      if (from !== to) ranges.push({ from, to });
    } catch {
      // Ignore DOM selections CodeMirror cannot map to document positions.
    }
  }

  if (ranges.length === 0) return null;
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);

  return ranges
    .map((range) => view.state.sliceDoc(range.from, range.to))
    .join(view.state.lineBreak);
}

function linewiseSelectionText(state: EditorState): string {
  const lines: string[] = [];
  let lastLine = -1;

  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.from);
    if (line.number <= lastLine) continue;
    lines.push(line.text);
    lastLine = line.number;
  }

  return lines.join(state.lineBreak);
}

export function getEditorClipboardText(view: EditorView): string {
  return (
    selectionTextFromState(view.state) ??
    selectionTextFromDom(view) ??
    linewiseSelectionText(view.state)
  );
}

export function modelBackedCopyExtension(): Extension {
  return EditorView.domEventHandlers({
    copy(event, view) {
      const clipboard = event.clipboardData;
      if (!clipboard) return false;

      const text = getEditorClipboardText(view);
      if (!text) return false;

      clipboard.clearData();
      clipboard.setData("text/plain", text);
      event.preventDefault();
      return true;
    },
  });
}
