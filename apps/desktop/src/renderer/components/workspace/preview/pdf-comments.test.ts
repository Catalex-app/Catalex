import { createPdfCommentLookup } from "./pdf-comment-lookup";
import { describe, expect, it, vi } from "vitest";
import {
  pdfCommentTargets,
  pdfCommentTextRange,
  pdfCommentMatchesSource,
} from "./pdf-comments";
import type { ProjectFile } from "@/stores/document-store";
import { getSynctexSourceMap } from "@/lib/latex-compiler";
vi.mock("@/lib/latex-compiler", () => ({ getSynctexSourceMap: vi.fn() }));
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { extractStructuredText } from "@/lib/mupdf/structured-text";
import fixtureMap from "@/dev/fixtures/pdf-comments/multipage-map.json";
const sourceMap = {
  ...fixtureMap,
  inputs: { ...fixtureMap.inputs, 1: "multipage.tex" },
};

describe("PDF comment source ranges", () => {
  it("excludes resolved, empty and stale offsets and respects exclusive range ends", () => {
    const file = {
      relativePath: "chapter.tex",
      content: "First\nSecond\nThird",
    } as ProjectFile;
    const comment = { id: "one", from: 0, to: 6, line: 1, text: "Review" };
    const targets = pdfCommentTargets([file], {
      "chapter.tex": [
        comment,
        { ...comment, id: "resolved", resolved: true },
        { ...comment, id: "empty", text: "" },
        { ...comment, id: "stale", to: 999 },
      ],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      firstLine: 1,
      lastLine: 1,
      sourceText: "First\n",
    });
  });
  it("preserves source line boundaries across edits, CRLF and UTF-16 offsets", () => {
    const file = { relativePath: "chapter.tex", content: "" } as ProjectFile;
    for (const content of ["", "\n", "a\n\nb\n", "α😀\r\n中文\n", "a\n\nb\n"]) {
      file.content = content;
      const comments = [];
      for (let from = 0; from <= content.length; from++) {
        for (let to = from; to <= content.length; to++) {
          comments.push({
            id: `${from}:${to}`,
            from,
            to,
            line: 1,
            text: "Review",
          });
        }
      }
      const targets = pdfCommentTargets([file], { "chapter.tex": comments });
      expect(targets).toHaveLength(comments.length);
      for (const target of targets) {
        const { from, to } = target.comment;
        expect(target.firstLine).toBe(
          content.slice(0, from).split("\n").length,
        );
        expect(target.lastLine).toBe(
          content.slice(0, Math.max(from, to - 1)).split("\n").length,
        );
        expect(target.sourceText).toBe(content.slice(from, to));
      }
    }
  });
  it("matches partial selections, wrapping and PDF ligatures with original offsets", () => {
    expect(pdfCommentTextRange("office", "The oﬃce closes.")).toEqual([4, 8]);
    expect(
      pdfCommentTextRange("selected words", "Some selected words here"),
    ).toEqual([5, 19]);
    expect(
      pdfCommentTextRange(
        "selected words across lines",
        "prefix selected words",
      ),
    ).toEqual([7, 21]);
    expect(
      pdfCommentTextRange("selected words across lines", "across lines suffix"),
    ).toEqual([0, 12]);
    expect(pdfCommentTextRange("across\nlines", "across lines")).toEqual([
      0, 12,
    ]);
    expect(
      pdfCommentTextRange("another sentence", "Unrelated prose"),
    ).toBeNull();
  });
  it("matches formatted selections without widening to the surrounding line", () => {
    expect(
      pdfCommentTextRange(
        String.raw`\textbf{some words}`,
        "Before some words after",
      ),
    ).toEqual([7, 17]);
    expect(
      pdfCommentTextRange(
        String.raw`\textbf{some \emph{words}}`,
        "Before some words after",
      ),
    ).toEqual([7, 17]);
    expect(
      pdfCommentTextRange(
        String.raw`\href{https://example.com}{some words}`,
        "Before some words after",
      ),
    ).toEqual([7, 17]);
    expect(
      pdfCommentTextRange(
        String.raw`\textcolor{red}{some words}`,
        "Before some words after",
      ),
    ).toEqual([7, 17]);
    expect(pdfCommentTextRange(String.raw`50\%`, "About 50% remain")).toEqual([
      6, 9,
    ]);
    expect(pdfCommentTextRange("$x^2$", "Before x2 after")).toEqual([7, 9]);
    expect(
      pdfCommentTextRange(
        String.raw`\textbf{selected words across lines}`,
        "prefix selected words",
      ),
    ).toEqual([7, 21]);
    expect(
      pdfCommentTextRange(
        String.raw`\textbf{selected words across lines}`,
        "across lines suffix",
      ),
    ).toEqual([0, 12]);
  });
  it("does not paint unrelated lines for unmatched or unsupported LaTeX", () => {
    expect(
      pdfCommentTextRange(String.raw`\textbf{some words}`, "Unrelated prose"),
    ).toBeNull();
    expect(
      pdfCommentTextRange(
        String.raw`\custom{some words}`,
        "Before some words after",
      ),
    ).toBeNull();
    expect(
      pdfCommentTextRange(
        String.raw`\ref{some-words}`,
        "Before some words after",
      ),
    ).toBeNull();
    expect(
      pdfCommentTextRange(String.raw`\textbf{}`, "Unrelated prose"),
    ).toBeNull();
  });
  it("keeps prose around opaque citations and references", () => {
    const rendered =
      "Before ModelA Smith (2025) combines local and global attention. After";
    expect(
      pdfCommentTextRange(
        String.raw`ModelA~\cite{private-key} combines local and global attention.`,
        rendered,
      ),
    ).toEqual([7, rendered.indexOf(" After")]);
    expect(
      pdfCommentTextRange(
        String.raw`See Section~\ref{private-label} for details.`,
        "See Section 4 for details.",
      ),
    ).toEqual([0, 26]);
    expect(
      pdfCommentTextRange(
        String.raw`\custom{not-rendered} selected words`,
        "Before selected words after",
      ),
    ).toEqual([7, 21]);
    expect(
      pdfCommentTextRange(String.raw`\cite{private-key}`, "private-key"),
    ).toBeNull();
  });
  it("contains unsupported commands inside formatting without losing nearby text", () => {
    expect(
      pdfCommentTextRange(
        String.raw`\textbf{\cite{key}} selected words`,
        "Smith (2025) selected words",
      ),
    ).toEqual([13, 27]);
    expect(
      pdfCommentTextRange(
        String.raw`selected words \textbf{unfinished`,
        "selected words continue",
      ),
    ).toEqual([0, 14]);
  });
  it("bounds a trailing citation with the following unselected source", () => {
    expect(
      pdfCommentTextRange(
        String.raw`ModelA~\cite{key} `,
        "ModelA Smith (2025) performs well. Unselected",
        {
          sourceBefore: "",
          sourceAfter: "performs well. Unselected",
        },
      ),
    ).toEqual([0, 19]);
    expect(
      pdfCommentTextRange(
        String.raw`ModelA~\cite{key} `,
        "ModelA Smith (2025) performs well. Unselected",
      ),
    ).toEqual([0, 6]);
  });
  it("matches rendered mathematics, including selections inside an equation", () => {
    const source = String.raw`f_q(i_l^q) = \frac{x}{W} \cdot W`;
    for (const line of ["fq(iq", "l) =", "x", "W", "· W"]) {
      expect(pdfCommentTextRange(source, line), line).toEqual([0, line.length]);
    }
    expect(
      pdfCommentTextRange(
        String.raw`The union $\bigcup_{i\in S} i$ is connected.`,
        "The union ∪",
      ),
    ).toEqual([0, 11]);
    expect(
      pdfCommentTextRange(
        "Latency falls from 66s → 43s after tuning.",
        "Latency falls from 66s 43s after tuning.",
      ),
    ).toEqual([0, "Latency falls from 66s 43s after tuning.".length]);
  });
  it("shares one source-map read across pages and page remounts", async () => {
    vi.mocked(getSynctexSourceMap).mockClear().mockResolvedValue(sourceMap);
    const lookup = createPdfCommentLookup("/project");
    const controller = new AbortController();
    const abandoned = lookup(1, controller.signal);
    controller.abort();
    const signal = new AbortController().signal;
    const [page2, page3] = await Promise.all([
      lookup(2, signal),
      lookup(3, signal),
    ]);
    expect(await abandoned).toEqual([]);
    expect(page2.length).toBeGreaterThan(0);
    expect(page3.length).toBeGreaterThan(0);
    expect((await lookup(1, signal)).length).toBeGreaterThan(0);
    expect(getSynctexSourceMap).toHaveBeenCalledTimes(1);
  });
  it("retries an unavailable map and reloads for a new PDF revision", async () => {
    vi.mocked(getSynctexSourceMap)
      .mockClear()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(sourceMap);
    const signal = new AbortController().signal;
    const lookup = createPdfCommentLookup("/project");
    expect(await lookup(2, signal)).toEqual([]);
    expect((await lookup(2, signal)).length).toBeGreaterThan(0);
    await createPdfCommentLookup("/project")(2, signal);
    expect(getSynctexSourceMap).toHaveBeenCalledTimes(3);
  });
  it("highlights a source selection wrapping across two PDF lines on page 2", async () => {
    vi.mocked(getSynctexSourceMap).mockResolvedValue(sourceMap);
    const content = readFileSync(
      "src/renderer/dev/fixtures/pdf-comments/multipage.tex",
      "utf8",
    );
    const selected = "and continues with a particular selected phrase";
    const from = content.indexOf(selected);
    const [target] = pdfCommentTargets(
      [{ relativePath: "multipage.tex", content } as ProjectFile],
      {
        "multipage.tex": [
          {
            id: "wrapped",
            from,
            to: from + selected.length,
            line: 6,
            text: "Review",
          },
        ],
      },
    );
    const doc = mupdf.Document.openDocument(
      new Uint8Array(
        readFileSync("src/renderer/dev/fixtures/pdf-comments/multipage.pdf"),
      ),
      "application/pdf",
    );
    const lookup = createPdfCommentLookup("/project");
    try {
      const matches: Array<{ page: number; text: string }> = [];
      for (let index = 0; index < doc.countPages(); index++) {
        const page = doc.loadPage(index);
        const text = page.toStructuredText("preserve-whitespace");
        const boxes = await lookup(index + 1, new AbortController().signal);
        for (const line of extractStructuredText(text).blocks.flatMap(
          (b) => b.lines,
        )) {
          if (pdfCommentMatchesSource(target, line, boxes))
            matches.push({ page: index + 1, text: line.text });
          // Identical PDF text on another source line must not qualify.
          expect(
            pdfCommentMatchesSource(
              { ...target, firstLine: 3, lastLine: 3 },
              line,
              boxes,
            ),
          ).toBe(false);
        }
        text.destroy();
        page.destroy();
      }
      expect(matches).toEqual([
        {
          page: 2,
          text: "This paragraph starts with a short phrase and continues with a particular",
        },
        {
          page: 2,
          text: "selected phrase before moving to a different source line that also contains text.",
        },
      ]);
    } finally {
      doc.destroy();
    }
  });
});

it("highlights every wrapped line of the reported paragraph with typeset quotes", () => {
  const lines = [
    "Comments can be added to your project by highlighting some text and clicking “Add comment” in",
    "the top right of the editor pane. To view existing comments, click on the Review menu in the toolbar",
    "above. To reply to a comment, click on the Reply button in the lower right corner of the comment.",
    "You can close the Review pane by clicking its name on the toolbar when you’re done reviewing for the",
    "time being.",
  ];
  const source = lines
    .join(" ")
    .replace("“", "``")
    .replace("”", "''")
    .replace("’", "'");
  for (const line of lines) {
    expect(pdfCommentTextRange(source, line)).toEqual([0, line.length]);
  }
  expect(
    pdfCommentTextRange("``Add comment''", "Click “Add comment” here."),
  ).toEqual([6, 19]);
});

it("highlights prose and ellipses across list boundaries", () => {
  const source = String.raw`\item and like this.
\end{enumerate}
\dots or bullet points \dots`;
  expect(pdfCommentTextRange(source, "2. and like this.")).toEqual([3, 17]);
  for (const line of ["… or bullet points …", "...or bullet points ..."]) {
    expect(pdfCommentTextRange(source, line)).toEqual([0, line.length]);
  }
});
