import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { latex } from "codemirror-lang-latex";
import { markdown } from "@codemirror/lang-markdown";
import { proseWords } from "./prose";

function extract(
  doc: string,
  kind: "latex" | "markdown" | "text" = "latex",
  from = 0,
  to = doc.length,
) {
  const state = EditorState.create({
    doc,
    extensions:
      kind === "latex"
        ? latex({ enableLinting: false })
        : kind === "markdown"
          ? markdown()
          : [],
  });
  ensureSyntaxTree(state, doc.length, 1000);
  return proseWords(state, [{ from, to }], kind);
}

describe("spelling prose extraction", () => {
  it("checks headings, captions and formatting while excluding LaTeX syntax", () => {
    const doc = String.raw`\documentclass{badclass}
\usepackage{badpackage}
\section{Heading prose}
Ordinary words \textbf{bold words} \caption{Caption words}
\cite{badcite} \ref{badref} \label{badlabel}
\includegraphics[width=badwidth]{badfile}
\url{https://badurl.invalid} \href{https://badurl.invalid}{Link words}
$badmath$ \(badmath\) \[badmath\]
\begin{align}badmath\end{align}
\begin{verbatim}badcode\end{verbatim}
\newcommand{\badmacro}{baddefinition}
% badcomment
`;
    const words = extract(doc).map((word) => word.text);
    expect(words).toEqual([
      "Heading",
      "prose",
      "Ordinary",
      "words",
      "bold",
      "words",
      "Caption",
      "words",
      "Link",
      "words",
    ]);
  });
  it("excludes Markdown code, HTML and link destinations", () => {
    expect(
      extract(
        "# Heading\nVisible **bold** `badcode` [Link](https://badurl.invalid)\n```js\nbadcode\n```\n<div>badhtml</div>",
        "markdown",
      ).map((w) => w.text),
    ).toEqual(["Heading", "Visible", "bold", "Link"]);
  });
  it("preserves offsets and apostrophes and avoids clipped words and identifiers", () => {
    const doc = "😀 don't isn’t naïve some_key abc123 clipped";
    const words = extract(doc, "text", 1, doc.length - 2);
    expect(words.map((w) => w.text)).toEqual(["don't", "isn't", "naïve"]);
    expect(words.map((w) => doc.slice(w.from, w.to))).toEqual([
      "don't",
      "isn’t",
      "naïve",
    ]);
  });
  it("only extracts visible ranges in a large document", () => {
    const doc = `${"hidden words\n".repeat(20000)}visible words`;
    expect(extract(doc, "text", doc.length - 13).map((w) => w.text)).toEqual([
      "visible",
      "words",
    ]);
  });
});
