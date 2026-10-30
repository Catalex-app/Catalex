import { ChangeSet } from "@codemirror/state";
import { documentReplacementEdits } from "@/lib/document-model";

export function createDocumentChangeSet(
  before: string,
  after: string,
  lineSeparator?: string,
): ChangeSet {
  return ChangeSet.of(
    documentReplacementEdits(before, after),
    before.length,
    lineSeparator,
  );
}
