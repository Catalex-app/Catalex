import { describe, expect, it } from "vitest";
import type { ProjectFile } from "@/stores/document-store";
import {
  isMarkdownPath,
  resolveMarkdownProjectFile,
  rewriteMarkdownCssAssetUrls,
} from "./markdown";

function makeFile(relativePath: string): ProjectFile {
  return {
    id: relativePath,
    name: relativePath.split("/").pop() ?? relativePath,
    relativePath,
    absolutePath: `/project/${relativePath}`,
    type: "other",
    content: "",
    isDirty: false,
  };
}

describe("Markdown project paths", () => {
  it("recognizes common Markdown extensions case-insensitively", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("notes/Guide.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("paper.tex")).toBe(false);
  });

  it("resolves assets relative to the Markdown document", () => {
    const markdownFile = makeFile("docs/guide.md");
    const imageFile = makeFile("images/diagram.png");
    const resolved = resolveMarkdownProjectFile(
      "../images/diagram.png#wide",
      markdownFile,
      [markdownFile, imageFile],
    );

    expect(resolved).toEqual({ file: imageFile, suffix: "#wide" });
  });

  it("does not resolve external or out-of-project paths", () => {
    const markdownFile = makeFile("guide.md");
    expect(
      resolveMarkdownProjectFile(
        "https://example.com/image.png",
        markdownFile,
        [markdownFile],
      ),
    ).toBeNull();
    expect(
      resolveMarkdownProjectFile("../secret.png", markdownFile, [markdownFile]),
    ).toBeNull();
  });

  it("rewrites relative Typora theme assets to app asset URLs", () => {
    const themeFile = makeFile("themes/academic.css");
    const fontFile = makeFile("themes/fonts/serif.woff2");
    const css = '@font-face { src: url("./fonts/serif.woff2?#iefix"); }';

    expect(
      rewriteMarkdownCssAssetUrls(
        css,
        themeFile,
        [themeFile, fontFile],
        (absolutePath) => `asset://${absolutePath}`,
      ),
    ).toContain('url("asset:///project/themes/fonts/serif.woff2?#iefix")');
  });
});
