import { describe, expect, it } from "vitest";
import { resolveCompileTarget } from "@/lib/latex-compiler";
import { resolveTexRoot, type ProjectFile } from "@/stores/document-store";

function file(
  relativePath: string,
  content: string,
  type: ProjectFile["type"] = "tex",
): ProjectFile {
  return {
    id: relativePath,
    name: relativePath.split("/").pop() ?? relativePath,
    relativePath,
    absolutePath: `/project/${relativePath}`,
    type,
    content,
    isDirty: false,
  };
}

const root = (body = "") =>
  String.raw`\documentclass{article}\begin{document}${body}\end{document}`;

describe("resolveCompileTarget", () => {
  it("compiles the project root, not the first .tex file, when the active file is not LaTeX", () => {
    const files = [
      file("abstract.tex", "A fragment that cannot compile alone."),
      file("notes.md", "# Notes", "other"),
      file("paper.tex", root(String.raw`\input{abstract}`)),
    ];
    for (const activeFileId of ["notes.md", "", "missing"]) {
      expect(resolveCompileTarget(activeFileId, files)).toEqual({
        rootId: "paper.tex",
        targetPath: "paper.tex",
      });
    }
  });

  it("prefers main.tex over an earlier root when the active file is not LaTeX", () => {
    const files = [
      file("archive.tex", root()),
      file("main.tex", root()),
      file("refs.bib", "@book{a}", "bib"),
    ];
    expect(resolveCompileTarget("refs.bib", files)?.rootId).toBe("main.tex");
  });

  it("compiles the root that includes the active fragment", () => {
    const files = [
      file("broken.tex", String.raw`\documentclass{article}\begin{document}`),
      file("main.tex", root(String.raw`\input{sections/intro}`)),
      file("sections/method.tex", "Method"),
      file("thesis.tex", root(String.raw`\include{sections/method}`)),
    ];
    expect(resolveCompileTarget("sections/method.tex", files)?.rootId).toBe(
      "thesis.tex",
    );
    // A fragment no root includes keeps the well-known root.
    files.push(file("orphan.tex", "Orphan"));
    expect(resolveTexRoot("orphan.tex", files)).toBe("main.tex");
  });

  it("prefers main.tex among several roots that include the fragment", () => {
    const files = [
      file("alt.tex", root(String.raw`\input{body}`)),
      file("body.tex", "Body"),
      file("main.tex", root(String.raw`\input{body}`)),
    ];
    expect(resolveTexRoot("body.tex", files)).toBe("main.tex");
  });

  it("ignores hidden roots and falls back to a visible .tex file only without any root", () => {
    const hidden = file(".catalex/build/main.tex", root());
    const fragment = file("body.tex", "Body");
    const notes = file("notes.md", "# Notes", "other");
    expect(resolveCompileTarget("notes.md", [hidden, fragment, notes])).toEqual(
      { rootId: "body.tex", targetPath: "body.tex" },
    );
    expect(resolveCompileTarget("notes.md", [hidden, notes])).toBeNull();
  });
});
