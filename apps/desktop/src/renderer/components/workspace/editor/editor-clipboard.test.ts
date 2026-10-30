import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { getEditorClipboardText } from "./editor-clipboard";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.textContent = "";
});

function createView(doc: string): EditorView {
  const parent = document.body.appendChild(document.createElement("div"));
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [EditorView.lineWrapping],
    }),
  });
  return view;
}

function firstTextNode(root: ParentNode): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!(node instanceof Text)) {
    throw new Error("Expected editor text node");
  }
  return node;
}

describe("editor clipboard", () => {
  it("uses the document model for DOM selections when editor state is collapsed", () => {
    const line =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
    const editor = createView(`${line}\nsecond line`);
    editor.dispatch({ selection: { anchor: 0 } });

    const textNode = firstTextNode(editor.contentDOM);
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, line.length);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(getEditorClipboardText(editor)).toBe(line.slice(6));
  });

  it("prefers CodeMirror state selections when present", () => {
    const editor = createView("first line\nsecond line");
    editor.dispatch({ selection: { anchor: 0, head: 10 } });

    expect(getEditorClipboardText(editor)).toBe("first line");
  });
});
