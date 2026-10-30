import { expect, it } from "vitest";
import { createSourceLineIndex } from "./source-line-index";

it("round trips source positions including wrapped-length lines, empty lines, Unicode and EOF", () => {
  for (const content of [
    "",
    "abc",
    "a\n\n😀xyz\n",
    `${"a".repeat(10000)}\nlast`,
  ]) {
    const index = createSourceLineIndex(content);
    for (let position = 0; position <= content.length; position++) {
      expect(index.offset(index.coordinate(position))).toBe(position);
      const prefix = content.slice(0, position);
      expect(index.lineAndColumn(position)).toEqual({
        line: prefix.split("\n").length,
        column: position - prefix.lastIndexOf("\n"),
      });
    }
  }
});

it("clamps native line/column lookups to the actual document", () => {
  const index = createSourceLineIndex("abc\ndef");
  expect(index.offset(-20, -1)).toBe(0);
  expect(index.offset(200, 500)).toBe(7);
  expect(index.offset(2, 0)).toBe(4);
});

it("preserves the end of a million-character wrapped line", () => {
  const content = "x".repeat(1_000_000);
  const index = createSourceLineIndex(content);
  for (const position of [0, 1, 500_000, 999_999, 1_000_000])
    expect(index.offset(index.coordinate(position))).toBe(position);
});
