import { expect, it } from "vitest";
import { rebaseDocumentEdit } from "./rebase-document-edit";

it("preserves another view's edit when an editor transaction used older text", () => {
  expect(
    rebaseDocumentEdit("alpha\nbeta", "alpha\nbeta!", "new alpha\nbeta"),
  ).toBe("new alpha\nbeta!");
});
it("maps emoji and simultaneous inserts without dropping either edit", () => {
  expect(rebaseDocumentEdit("😀 end", "😀 local end", "😀 remote end")).toBe(
    "😀 remote local end",
  );
});
