import { ChangeSet, Text } from "@codemirror/state";
import { documentReplacementEdits } from "./document-model";

/** Preserve intervening edits when another view types before React refreshes it. */
export function rebaseDocumentEdit(
  base: string,
  next: string,
  current: string,
) {
  if (base === current || next === current) return next;
  const local = ChangeSet.of(documentReplacementEdits(base, next), base.length);
  const remote = ChangeSet.of(
    documentReplacementEdits(base, current),
    base.length,
  );
  return local
    .map(remote)
    .apply(Text.of(current.split("\n")))
    .toString();
}
