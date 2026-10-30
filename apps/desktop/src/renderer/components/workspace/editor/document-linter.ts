import {
  forceParsing,
  syntaxTree,
  syntaxTreeAvailable,
} from "@codemirror/language";
import { linter, type LintSource } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";

// Background parsing stops beyond the viewport. Complete it in short slices
// while this lint extension is mounted; edits use the current document and
// switching files or suppressing lint cancels the old view's pending work.
const completeDocumentParsing = ViewPlugin.define((view) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!forceParsing(view, view.state.doc.length, 20)) schedule();
    }, 20);
  };
  schedule();
  return {
    update(update) {
      if (update.docChanged) schedule();
    },
    destroy() {
      clearTimeout(timer);
    },
  };
});

/** Run document-wide checks when a complete syntax tree is published. */
export function documentLinter(source: LintSource): Extension {
  return [
    completeDocumentParsing,
    linter(
      (view) => {
        if (!syntaxTreeAvailable(view.state, view.state.doc.length)) return [];
        return source(view);
      },
      {
        needsRefresh: (update) =>
          syntaxTree(update.startState) !== syntaxTree(update.state),
      },
    ),
  ];
}
