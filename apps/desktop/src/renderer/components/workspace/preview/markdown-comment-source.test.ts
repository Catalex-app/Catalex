import { afterEach, describe, expect, it } from "vitest";
import { markdownSelectionRange } from "./markdown-comment-source";

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

function select(
  source: string,
  chunks: { text: string; from: number; to: number }[],
  start: number,
  end: number,
) {
  for (const chunk of chunks) {
    const span = document.createElement("span");
    span.dataset.commentStart = String(chunk.from);
    span.dataset.commentEnd = String(chunk.to);
    span.textContent = chunk.text;
    document.body.append(span);
  }
  const range = document.createRange();
  range.setStart(document.body.firstChild!.firstChild!, start);
  range.setEnd(document.body.lastChild!.firstChild!, end);
  const selection = document.getSelection()!;
  selection.addRange(range);
  return markdownSelectionRange(selection, source);
}

describe("Markdown comment selection", () => {
  it("anchors repeated text to its own source occurrence", () => {
    expect(
      select("same **same**", [{ text: "same", from: 7, to: 11 }], 1, 4),
    ).toEqual({ from: 8, to: 11, line: 1 });
  });
  it("includes formatting between endpoints spanning multiple blocks", () => {
    expect(
      select(
        "**one**\n\ntwo",
        [
          { text: "one", from: 2, to: 5 },
          { text: "two", from: 9, to: 12 },
        ],
        1,
        2,
      ),
    ).toEqual({ from: 3, to: 11, line: 1 });
  });
  it("maps decoded entities to the entire entity", () => {
    expect(select("&amp;", [{ text: "&", from: 0, to: 5 }], 0, 1)).toEqual({
      from: 0,
      to: 5,
      line: 1,
    });
  });
  it("uses UTF-16 offsets matching the editor", () => {
    expect(
      select("# 标题\n\n你好🌏", [{ text: "你好🌏", from: 6, to: 10 }], 2, 4),
    ).toEqual({ from: 8, to: 10, line: 3 });
  });
});
