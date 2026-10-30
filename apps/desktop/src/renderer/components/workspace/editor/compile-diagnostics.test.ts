import { diagnosticCount, forEachDiagnostic, linter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it } from "vitest";
import {
  compileDiagnosticExtension,
  compileDiagnosticField,
  locateCompileDiagnostics,
  replaceCompileDiagnostics,
  restoreCompilerMarkers,
} from "./compile-diagnostics";

let view: EditorView | undefined;
afterEach(() => view?.destroy());

it("combines compiler markers with live lint and maps their positions after edits", async () => {
  view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({
      doc: "first\nsecond\nthird",
      extensions: [
        linter(() => [
          { from: 0, to: 1, severity: "error", message: "Live error" },
        ]),
        compileDiagnosticExtension,
      ],
    }),
  });
  const results = [
    {
      severity: "warning" as const,
      message: "Compiler warning",
      file: "main.tex",
      line: 3,
    },
  ];
  const located = locateCompileDiagnostics(view.state.doc, "main.tex", results);
  view.dispatch({
    effects: replaceCompileDiagnostics.of({
      results,
      diagnostics: located.located,
    }),
  });
  await expect.poll(() => diagnosticCount(view!.state)).toBe(2);
  expect(view.dom.querySelector(".cm-lintRange-warning")).not.toBeNull();
  view.dispatch({ changes: { from: 0, insert: "new line\n" } });
  await expect
    .poll(() => {
      let line = 0;
      forEachDiagnostic(view!.state, (d, from) => {
        if (d.source === "compile") line = view!.state.doc.lineAt(from).number;
      });
      return line;
    })
    .toBe(4);
  expect(view.state.field(compileDiagnosticField).results).toBe(results);
  view.dispatch({
    effects: replaceCompileDiagnostics.of({ results: [], diagnostics: [] }),
  });
  await expect.poll(() => diagnosticCount(view!.state)).toBe(1);
});

it("keeps missing, foreign, and invalid locations out of the editor", () => {
  const doc = EditorState.create({ doc: "one\ntwo" }).doc;
  const results = [
    { severity: "warning" as const, message: "Global" },
    {
      severity: "warning" as const,
      message: "Foreign",
      file: "included.tex",
      line: 2,
    },
    {
      severity: "error" as const,
      message: "Old line",
      file: "main.tex",
      line: 99,
    },
    {
      severity: "error" as const,
      message: "Bad line",
      file: "main.tex",
      line: 0,
    },
  ];
  expect(locateCompileDiagnostics(doc, "main.tex", results)).toEqual({
    located: [],
    unlocated: results,
  });
});

it("restores mapped locations across file switches and rejects externally changed content", () => {
  let state = EditorState.create({
    doc: "first\nsecond",
    extensions: compileDiagnosticExtension,
  });
  const results = [
    {
      severity: "warning" as const,
      message: "Warning",
      file: "main.tex",
      line: 2,
    },
  ];
  const located = locateCompileDiagnostics(state.doc, "main.tex", results);
  state = state.update({
    effects: replaceCompileDiagnostics.of({
      results,
      diagnostics: located.located,
    }),
  }).state;
  state = state.update({ changes: { from: 0, insert: "new\n" } }).state;
  const snapshot = {
    doc: state.doc,
    markers: state.field(compileDiagnosticField),
  };
  const reopened = EditorState.create({ doc: state.doc.toString() });
  const restored = restoreCompilerMarkers(snapshot, reopened.doc);
  expect(reopened.doc.lineAt(restored.diagnostics[0].from).number).toBe(3);
  const external = EditorState.create({ doc: "Different contents\nsecond" });
  expect(restoreCompilerMarkers(snapshot, external.doc)).toEqual({
    results,
    diagnostics: [],
    unlocated: results,
  });
});
