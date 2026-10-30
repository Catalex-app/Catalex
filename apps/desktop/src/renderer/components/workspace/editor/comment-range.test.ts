import { expandPointCommentRange } from "./comment-range";
import { describe, expect, it } from "vitest";
import { resizeCommentRange } from "./comment-range";

describe("comment endpoint resizing", () => {
  const source = "First line\nSecond line\nThird line";
  const original = { from: 6, to: 17, line: 2 };
  it("keeps the opposite edge and derives the ending line", () => {
    expect(resizeCommentRange(source, original, "from", 0)).toEqual({
      from: 0,
      to: 17,
      line: 2,
    });
    expect(resizeCommentRange(source, original, "to", 26)).toEqual({
      from: 6,
      to: 26,
      line: 3,
    });
  });
  it("rejects collapsed, crossed, empty, and out-of-document ranges", () => {
    for (const offset of [6, 5, -1, 100, NaN])
      expect(resizeCommentRange(source, original, "to", offset)).toBeNull();
    expect(
      resizeCommentRange(source, { from: 10, to: 17, line: 2 }, "to", 11),
    ).toBeNull();
  });
});

it("expands a point in either direction and returns to the original point", () => {
  const point = { from: 4, to: 4, line: 1 };
  expect(expandPointCommentRange("abcdefghij", point, 2)).toEqual({
    from: 2,
    to: 4,
    line: 1,
  });
  expect(expandPointCommentRange("abcdefghij", point, 8)).toEqual({
    from: 4,
    to: 8,
    line: 1,
  });
  expect(expandPointCommentRange("abcdefghij", point, 4)).toEqual(point);
  expect(expandPointCommentRange("abcdefghij", point, 11)).toBeNull();
});
