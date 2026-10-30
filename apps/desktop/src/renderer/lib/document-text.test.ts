import { expect, it } from "vitest";
import {
  encodeDocumentText,
  normalizeDocumentText,
  normalizeReviewText,
} from "./document-text";

it("uses LF coordinates while preserving disk line endings when saving", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const disk = `😀 first${ending}selected${ending}`;
    const document = normalizeDocumentText(disk);
    expect(document.indexOf("selected")).toBe(9);
    expect(
      encodeDocumentText(document.replace("selected", "edited"), disk),
    ).toBe(`😀 first${ending}edited${ending}`);
    expect(normalizeDocumentText(encodeDocumentText(document, disk))).toBe(
      document,
    );
  }
  expect(encodeDocumentText("new\nfile\n", "")).toBe("new\nfile\n");
});

it("normalizes all review versions but preserves native revision tokens", () => {
  const review = normalizeReviewText({
    oldContent: "old\r\n",
    newContent: "new\r\n",
    proposalRevision: "opaque-token",
    conflictContents: [
      { kind: "resolved" as const, content: "prefix\r\n" },
      {
        kind: "conflict" as const,
        ancestor: "a\r\n",
        current: "c\r\n",
        agent: "b\r\n",
      },
    ],
  });
  expect(review).toEqual({
    oldContent: "old\n",
    newContent: "new\n",
    proposalRevision: "opaque-token",
    conflictContents: [
      { kind: "resolved", content: "prefix\n" },
      { kind: "conflict", ancestor: "a\n", current: "c\n", agent: "b\n" },
    ],
  });
});
