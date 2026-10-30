import { expect, it } from "vitest";
import {
  findPdfCommentRange,
  matchPdfCommentRange,
  pickPdfCommentRange,
} from "./pdf-comment-selection";

it("keeps exact source offsets across PDF wrapping and ligatures", () => {
  const source =
    "Earlier text.\nEfficient sparse attention spans\nseveral lines. Later text.";
  const range = findPdfCommentRange(
    source,
    "Efﬁcient sparse attention spans several lines.",
  );
  expect(source.slice(range!.from, range!.to)).toBe(
    "Efficient sparse attention spans\nseveral lines.",
  );
});
it("matches formatting and citation gaps between selected endpoints", () => {
  const source = String.raw`Sparse attention has been widely explored by \textbf{several authors} \cite{smith2025} to reduce the computational cost.`;
  const range = findPdfCommentRange(
    source,
    "Sparse attention has been widely explored by several authors (Smith, 2025) to reduce the computational cost.",
  );
  expect(source.slice(range!.from, range!.to)).toBe(source);
});
it("uses the SyncTeX line to distinguish repeated text, and rejects ambiguity without it", () => {
  const source = "Same selected phrase.\nOther text.\nSame selected phrase.";
  expect(findPdfCommentRange(source, "Same selected phrase.")).toBeNull();
  expect(findPdfCommentRange(source, "Same selected phrase.", 3)?.line).toBe(3);
  expect(findPdfCommentRange(source, "not in the source")).toBeNull();
});

it("matches short selections crossing formatting boundaries", () => {
  const source = String.raw`A \textbf{short phrase} follows.`;
  const range = findPdfCommentRange(source, "A short phrase");
  expect(range).not.toBeNull();
  expect(source.slice(range!.from, range!.to)).toBe(
    String.raw`A \textbf{short phrase}`,
  );
});

it("matches selections beginning inside formatting and ending in plain text", () => {
  const source = String.raw`\emph{Important words} follow here.`;
  const range = findPdfCommentRange(source, "words follow");
  expect(source.slice(range!.from, range!.to)).toBe("words} follow");
});

it("does not pick arbitrarily between equally close repeated matches", () => {
  expect(
    findPdfCommentRange(
      "Same phrase.\nOther.\nSame phrase.",
      "Same phrase.",
      2,
    ),
  ).toBeNull();
});

it("reports ambiguity separately so other files cannot hide unresolved matches", () => {
  expect(
    matchPdfCommentRange("Same phrase. Same phrase.", "Same phrase."),
  ).toEqual({ status: "ambiguous" });
  expect(matchPdfCommentRange("Unrelated text", "Same phrase.")).toEqual({
    status: "unmatched",
  });
});

it("uses a source line inside a wrapped match rather than just its first line", () => {
  const source = "Repeated\nselected\nphrase\nRepeated selected phrase";
  expect(findPdfCommentRange(source, "Repeated selected phrase", 3)?.from).toBe(
    0,
  );
});

it("uses surrounding PDF text to distinguish repeated phrases on the same source line", () => {
  const source =
    "First context: same phrase ends here. Second context: same phrase continues there.";
  const range = findPdfCommentRange(source, "same phrase", 1, {
    before: "Second context: ",
    after: " continues there.",
  });
  expect(range?.from).toBe(source.lastIndexOf("same phrase"));
});

it("uses surrounding text without SyncTeX, but keeps identical contexts ambiguous", () => {
  const source = "First: same phrase.\nSecond: same phrase.";
  expect(
    findPdfCommentRange(source, "same phrase", undefined, {
      before: "Second: ",
      after: ".",
    })?.line,
  ).toBe(2);
  expect(
    findPdfCommentRange(source, "same phrase", undefined, {
      before: "",
      after: ".",
    }),
  ).toBeNull();
});

it("does not select hidden comments or citation keys", () => {
  expect(
    findPdfCommentRange("% hidden phrase\nVisible text", "hidden phrase"),
  ).toBeNull();
  expect(
    findPdfCommentRange(
      String.raw`Visible \cite{secret-key} text`,
      "secret-key",
    ),
  ).toBeNull();
});

it("preserves source spans for nested formatting and escaped symbols", () => {
  const source = String.raw`A \textbf{short \emph{bold} phrase} costs 50\%.`;
  const range = findPdfCommentRange(source, "A short bold phrase costs 50%.");
  expect(source.slice(range!.from, range!.to)).toBe(source);
});

it("automatically chooses the first occurrence for a tied repeated phrase", () => {
  const result = pickPdfCommentRange(
    [{ filePath: "main.tex", content: "Same phrase.\nSame phrase." }],
    "Same phrase.",
  );
  expect(result).toMatchObject({
    filePath: "main.tex",
    range: { from: 0 },
    approximate: true,
  });
});

it("uses context before SyncTeX proximity and the active file", () => {
  const result = pickPdfCommentRange(
    [
      { filePath: "active.tex", content: "Other context: same phrase ends." },
      {
        filePath: "chapter.tex",
        content: "Correct context: same phrase continues.",
      },
    ],
    "same phrase",
    {
      activeFilePath: "active.tex",
      source: { filePath: "active.tex", line: 1 },
      context: { before: "Correct context: ", after: " continues." },
    },
  );
  expect(result).toMatchObject({ filePath: "chapter.tex", approximate: false });
});

it("prefers SyncTeX proximity over the active file when context is tied", () => {
  const result = pickPdfCommentRange(
    [
      { filePath: "active.tex", content: "Same phrase." },
      {
        filePath: "chapter.tex",
        content: "Same phrase.\nOther.\nSame phrase.",
      },
    ],
    "Same phrase.",
    {
      activeFilePath: "active.tex",
      source: { filePath: "chapter.tex", line: 3 },
    },
  );
  expect(result).toMatchObject({
    filePath: "chapter.tex",
    range: { line: 3 },
    approximate: false,
  });
});

it("prefers the active file then stable file/source order and reports the fallback", () => {
  const files = [
    { filePath: "z.tex", content: "Same phrase." },
    { filePath: "a.tex", content: "Same phrase." },
  ];
  expect(
    pickPdfCommentRange(files, "Same phrase.", { activeFilePath: "z.tex" }),
  ).toMatchObject({ filePath: "z.tex", approximate: true });
  expect(pickPdfCommentRange(files, "Same phrase.")).toMatchObject({
    filePath: "a.tex",
    approximate: true,
  });
  expect(
    pickPdfCommentRange([...files].reverse(), "Same phrase."),
  ).toMatchObject({ filePath: "a.tex", approximate: true });
});

it("does not invent a match when no candidate exists", () => {
  expect(
    pickPdfCommentRange(
      [{ filePath: "main.tex", content: "Unrelated text" }],
      "Missing phrase",
    ),
  ).toBeNull();
});

it("maps typeset quotes back to complete TeX quote spans", () => {
  const source = "Click ``Add comment'' when you're ready.";
  const range = findPdfCommentRange(source, "“Add comment”");
  expect(source.slice(range!.from, range!.to)).toBe("``Add comment''");
  expect(
    findPdfCommentRange(source, "Click “Add comment” when you’re ready."),
  ).toEqual({
    from: 0,
    to: source.length,
    line: 1,
  });
});

it("maps a numbered item and following ellipses across a list boundary", () => {
  const source = String.raw`\begin{enumerate}
\item Like this,
\item and like this.
\end{enumerate}
\dots or bullet points \dots
\begin{itemize}
\item Like this,
\item and like this.
\end{itemize}`;
  for (const dots of ["…", "..."]) {
    const range = findPdfCommentRange(
      source,
      `2. and like this.\n${dots} or bullet points ${dots}`,
    );
    expect(range).not.toBeNull();
    expect(
      source.slice(range!.from, range!.to),
    ).toBe(String.raw`\item and like this.
\end{enumerate}
\dots or bullet points \dots`);
  }
  const bullet = findPdfCommentRange(source, "• and like this.");
  expect(source.slice(bullet!.from, bullet!.to)).toBe(
    String.raw`\item and like this.`,
  );
  expect(bullet!.from).toBe(source.lastIndexOf(String.raw`\item`));
});

it("uses bounded generated-text gaps with formatted anchors", () => {
  const source = String.raw`See \ref{sec:method} for \emph{details}.`;
  const result = pickPdfCommentRange(
    [{ filePath: "main.tex", content: source }],
    "See 2.3 for details.",
  );
  expect(result).toMatchObject({
    range: { from: 0, to: source.length },
    approximate: true,
  });
  expect(findPdfCommentRange(source, "2.3")).toBeNull();
  expect(
    findPdfCommentRange(
      source,
      "See completely unrelated text that is far too long for details.",
    ),
  ).toBeNull();
});

it("prefers an exact match over a generated-text fallback in another file", () => {
  expect(
    pickPdfCommentRange(
      [
        {
          filePath: "a.tex",
          content: String.raw`See \custom{hidden} for details.`,
        },
        { filePath: "b.tex", content: "See output for details." },
      ],
      "See output for details.",
      { activeFilePath: "a.tex" },
    ),
  ).toMatchObject({ filePath: "b.tex", approximate: false });
});

it("rejects weak anchors and fallback matches far from the SyncTeX line", () => {
  expect(
    findPdfCommentRange(String.raw`A \custom{x} B`, "A generated B"),
  ).toBeNull();
  expect(
    findPdfCommentRange(
      String.raw`See \custom{x} for details.`,
      "See output for details.",
      20,
    ),
  ).toBeNull();
  expect(
    findPdfCommentRange(
      String.raw`See \custom{x} for details.`,
      "See " + "x".repeat(65) + " for details.",
    ),
  ).toBeNull();
});

it.each([
  ["---", "—"],
  ["--", "–"],
  [String.raw`\textemdash`, "—"],
  [String.raw`\textendash`, "–"],
])("maps %s to its rendered dash with complete source offsets", (tex, glyph) => {
  const source = `Before ${tex} after.`;
  const range = findPdfCommentRange(source, `Before ${glyph}`);
  expect(range).not.toBeNull();
  expect(source.slice(range!.from, range!.to)).toBe(`Before ${tex}`);
  expect(
    pickPdfCommentRange(
      [{ filePath: "main.tex", content: source }],
      `Before ${glyph} after.`,
    ),
  ).toMatchObject({
    approximate: false,
    range: { from: 0, to: source.length, line: 1 },
  });
});

it("keeps en dashes and em dashes distinct", () => {
  expect(findPdfCommentRange("Before -- after.", "Before — after.")).toBeNull();
});
