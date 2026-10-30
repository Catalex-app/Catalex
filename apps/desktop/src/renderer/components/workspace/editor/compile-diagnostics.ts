import { linter, type Diagnostic } from "@codemirror/lint";
import { StateEffect, StateField, type Text } from "@codemirror/state";
import type { CompileDiagnostic } from "@/lib/latex-compiler";

export interface CompilerMarkers {
  results: CompileDiagnostic[];
  diagnostics: Diagnostic[];
  unlocated?: CompileDiagnostic[];
}

export interface CompilerMarkerSnapshot {
  doc: Text;
  markers: CompilerMarkers;
}

export function restoreCompilerMarkers(
  snapshot: CompilerMarkerSnapshot,
  doc: Text,
): CompilerMarkers {
  return snapshot.doc.eq(doc)
    ? snapshot.markers
    : {
        results: snapshot.markers.results,
        diagnostics: [],
        unlocated: snapshot.markers.results,
      };
}

export const replaceCompileDiagnostics = StateEffect.define<CompilerMarkers>();
export const compileDiagnosticField = StateField.define<CompilerMarkers>({
  create: () => ({ results: [], diagnostics: [] }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(replaceCompileDiagnostics)) return effect.value;
    }
    if (!transaction.docChanged) return value;
    return {
      ...value,
      diagnostics: value.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        from: transaction.changes.mapPos(diagnostic.from, 1),
        to: transaction.changes.mapPos(diagnostic.to, 1),
      })),
    };
  },
});

export const compileDiagnosticExtension = [
  compileDiagnosticField,
  linter((view) => view.state.field(compileDiagnosticField).diagnostics, {
    needsRefresh: (update) =>
      update.startState.field(compileDiagnosticField) !==
      update.state.field(compileDiagnosticField),
  }),
];

export function locateCompileDiagnostics(
  doc: Text,
  file: string,
  results: CompileDiagnostic[],
): { located: Diagnostic[]; unlocated: CompileDiagnostic[] } {
  const located: Diagnostic[] = [];
  const unlocated: CompileDiagnostic[] = [];
  for (const diagnostic of results) {
    if (
      diagnostic.file !== file ||
      !Number.isInteger(diagnostic.line) ||
      diagnostic.line! < 1 ||
      diagnostic.line! > doc.lines
    ) {
      unlocated.push(diagnostic);
      continue;
    }
    const line = doc.line(diagnostic.line!);
    const endLine = Math.min(
      doc.lines,
      Math.max(
        line.number,
        Number.isInteger(diagnostic.end_line)
          ? diagnostic.end_line!
          : line.number,
      ),
    );
    located.push({
      from: line.from,
      to: doc.line(endLine).to,
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: "compile",
    });
  }
  return { located, unlocated };
}
