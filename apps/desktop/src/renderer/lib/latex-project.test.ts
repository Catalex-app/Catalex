import { describe, expect, it } from "vitest";
import {
  isIncludedLatexFile,
  latexDocumentFileIds,
  shouldMuteLatexScrollSync,
} from "@/lib/latex-project";
import type { ProjectFile } from "@/stores/document-store";

function texFile(relativePath: string, content: string): ProjectFile {
  const pathParts = relativePath.split("/");
  const name = pathParts[pathParts.length - 1] ?? relativePath;
  return {
    id: relativePath,
    name,
    relativePath,
    absolutePath: `/project/${relativePath}`,
    type: "tex",
    content,
    isDirty: false,
  };
}

describe("LaTeX multi-file document detection", () => {
  it("finds recursively included source files and excludes unrelated files", () => {
    const files = [
      texFile(
        "main.tex",
        String.raw`\documentclass{book}
\include{chapters/one}
\begin{document}
\end{document}`,
      ),
      texFile(
        "chapters/one.tex",
        String.raw`% !TEX root = main.tex
\input{chapters/details}`,
      ),
      texFile("chapters/details.tex", "Details"),
      texFile("scratch.tex", "Unrelated notes"),
    ];

    expect([...latexDocumentFileIds("main.tex", files)]).toEqual([
      "main.tex",
      "chapters/one.tex",
      "chapters/details.tex",
    ]);
    expect(shouldMuteLatexScrollSync("main.tex", files)).toBe(true);
    expect(shouldMuteLatexScrollSync("chapters/one.tex", files)).toBe(true);
    expect(shouldMuteLatexScrollSync("chapters/details.tex", files)).toBe(true);
    expect(shouldMuteLatexScrollSync("scratch.tex", files)).toBe(false);
    expect(isIncludedLatexFile("main.tex", files)).toBe(false);
    expect(isIncludedLatexFile("chapters/one.tex", files)).toBe(true);
    expect(isIncludedLatexFile("chapters/details.tex", files)).toBe(true);
    expect(isIncludedLatexFile("scratch.tex", files)).toBe(false);
  });

  it("ignores commented includes and non-source include commands", () => {
    const files = [
      texFile(
        "main.tex",
        String.raw`\documentclass{article}
% \input{chapter}
\includegraphics{figure}`,
      ),
      texFile("chapter.tex", "Chapter"),
    ];

    expect(shouldMuteLatexScrollSync("main.tex", files)).toBe(false);
  });

  it("updates include membership after edits, file creation, deletion, and renaming", () => {
    const root = texFile(
      "main.tex",
      String.raw`\documentclass{book}\input{chapter}`,
    );
    const chapter = texFile("chapter.tex", "Chapter");
    expect(shouldMuteLatexScrollSync(root.id, [root])).toBe(false);
    expect(shouldMuteLatexScrollSync(root.id, [root, chapter])).toBe(true);
    expect(shouldMuteLatexScrollSync(root.id, [root])).toBe(false);
    chapter.relativePath = "renamed.tex";
    expect(shouldMuteLatexScrollSync(root.id, [root, chapter])).toBe(false);
    root.content = String.raw`\documentclass{book}\input{renamed}`;
    expect(shouldMuteLatexScrollSync(root.id, [root, chapter])).toBe(true);
    const edited = {
      ...root,
      content: "\\documentclass{book}\n% \\input{renamed}",
    };
    expect(shouldMuteLatexScrollSync(root.id, [edited, chapter])).toBe(false);
  });

  it("resolves relative includes after a source move and handles recursive cycles", () => {
    const root = texFile(
      "book.tex",
      String.raw`\documentclass{book}\input{child}`,
    );
    const child = texFile("child.tex", String.raw`\input{book}`);
    expect([...latexDocumentFileIds(root.id, [root, child])]).toEqual([
      root.id,
      child.id,
    ]);
    const otherChild = texFile("parts/child.tex", "Other project child");
    root.relativePath = "parts/book.tex";
    expect([...latexDocumentFileIds(root.id, [root, otherChild])]).toEqual([
      root.id,
      otherChild.id,
    ]);
    // Same ID in another project must not reuse the old source's include paths.
    const otherRoot = { ...root, content: "\\documentclass{article}" };
    expect(
      shouldMuteLatexScrollSync(otherRoot.id, [otherRoot, otherChild]),
    ).toBe(false);
  });
});
