import { describe, expect, it } from "vitest";
import {
  parseDocumentOutline,
  indexOutlinePositions,
  findCurrentOutlineLine,
} from "./document-outline";

describe("document outline", () => {
  it("extracts Markdown ATX headings with levels, numbers, and source lines", () => {
    const content = `# Introduction

## Background
Text
### Details

## Conclusion`;

    expect(parseDocumentOutline(content, "markdown")).toEqual([
      { level: 1, number: "", title: "Introduction", line: 1 },
      { level: 2, number: "", title: "Background", line: 3 },
      { level: 3, number: "", title: "Details", line: 5 },
      { level: 2, number: "", title: "Conclusion", line: 7 },
    ]);
  });

  it("supports Setext headings and strips inline Markdown decoration", () => {
    const content = `Project **overview** &amp; notes
================================

Using [links](https://example.com), \`code_x\`, and snake_case
-------------------------------------------------------------`;

    expect(parseDocumentOutline(content, "markdown")).toEqual([
      {
        level: 1,
        number: "",
        title: "Project overview & notes",
        line: 1,
      },
      {
        level: 2,
        number: "",
        title: "Using links, code_x, and snake_case",
        line: 4,
      },
    ]);
  });

  it("ignores heading-like text inside fenced code", () => {
    const content = `# Real heading

\`\`\`markdown
## Not an outline heading
\`\`\`

## Real child`;

    expect(parseDocumentOutline(content, "markdown")).toEqual([
      { level: 1, number: "", title: "Real heading", line: 1 },
      { level: 2, number: "", title: "Real child", line: 7 },
    ]);
  });

  it("preserves the existing LaTeX section outline behavior", () => {
    const content = `\\section{First}
% \\section{Commented out}
\\subsection{Child}
Text \\% \\subsubsection{Escaped percent}`;

    expect(parseDocumentOutline(content, "latex")).toEqual([
      { level: 2, number: "1", title: "First", line: 1 },
      { level: 3, number: "1.1", title: "Child", line: 3 },
      {
        level: 4,
        number: "1.1.1",
        title: "Escaped percent",
        line: 4,
      },
    ]);
  });
});

describe("current outline heading", () => {
  it("tracks boundaries and falls back to visible ancestors", () => {
    const content = "Preface\n# Parent\nText\n## Child\nBody\n# Next";
    const headings = parseDocumentOutline(content, "markdown");
    const index = indexOutlinePositions(content, headings);
    expect(findCurrentOutlineLine(index, 0)).toBeNull();
    expect(findCurrentOutlineLine(index, content.indexOf("# Parent"))).toBe(2);
    expect(findCurrentOutlineLine(index, content.indexOf("## Child") - 1)).toBe(
      2,
    );
    expect(findCurrentOutlineLine(index, content.indexOf("Body"))).toBe(4);
    expect(findCurrentOutlineLine(index, content.length)).toBe(6);
    expect(
      findCurrentOutlineLine(
        indexOutlinePositions(content, [headings[0], headings[2]]),
        content.indexOf("Body"),
      ),
    ).toBe(2);
    expect(findCurrentOutlineLine([], 100)).toBeNull();
  });
});
