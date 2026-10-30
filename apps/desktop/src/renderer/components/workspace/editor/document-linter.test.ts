import { forceParsing, syntaxTreeAvailable } from "@codemirror/language";
import { diagnosticCount, forEachDiagnostic } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { latex, latexLinter } from "codemirror-lang-latex";
import { afterEach, describe, expect, it } from "vitest";
import { documentLinter } from "./document-linter";

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.textContent = "";
});

const brokenDocument =
  "\\documentclass{article}\n\\begin{itemize}\n\\item Hello\n" +
  "Text with $x^2$ and \\textbf{words}.\n".repeat(4000);

function openDocument(doc: string) {
  view?.destroy();
  const parent = document.body.appendChild(document.createElement("div"));
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        latex({ enableLinting: false }),
        documentLinter(latexLinter()),
      ],
    }),
  });
  return view;
}

function messages(editor: EditorView) {
  const values: string[] = [];
  forEachDiagnostic(editor.state, (diagnostic) =>
    values.push(diagnostic.message),
  );
  return values;
}

describe("document lint lifecycle", () => {
  it("restores existing problems after remounting a long file without an edit", async () => {
    const first = openDocument(brokenDocument);
    forceParsing(first, first.state.doc.length, 1000);
    await expect.poll(() => diagnosticCount(first.state)).toBeGreaterThan(0);
    const expected = messages(first);

    const clean = openDocument(
      "\\documentclass{article}\n\\begin{document}Clean.\\end{document}",
    );
    expect(diagnosticCount(clean.state)).toBe(0);
    const restored = openDocument(brokenDocument);
    expect(syntaxTreeAvailable(restored.state, restored.state.doc.length)).toBe(
      false,
    );
    await expect
      .poll(() => messages(restored), { timeout: 4000 })
      .toEqual(expected);
  });

  it("checks edits extending past the background parser limit and clears repaired problems", async () => {
    const editor = openDocument(
      "\\documentclass{article}\n\\begin{document}Clean.\\end{document}",
    );
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: brokenDocument },
    });
    await expect
      .poll(() => diagnosticCount(editor.state), { timeout: 4000 })
      .toBeGreaterThan(0);
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert:
          "\\documentclass{article}\n\\begin{document}Fixed.\\end{document}",
      },
    });
    await expect.poll(() => diagnosticCount(editor.state)).toBe(0);
  });
});
