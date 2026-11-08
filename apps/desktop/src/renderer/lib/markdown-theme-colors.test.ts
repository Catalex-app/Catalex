import { describe, expect, it } from "vitest";
import {
  GENERIC_MARKDOWN_THEME_COLORS,
  markdownThemeColors,
} from "./markdown-theme-colors";

describe("approximate Markdown theme palettes", () => {
  it("uses surface colors and a heading accent from ordinary CSS", () => {
    expect(
      markdownThemeColors(`
      body { background: #f8f2e8; color: #2f2923; }
      #write h1 { color: rgb(126, 58, 47); }
    `),
    ).toEqual({
      background: "rgb(248, 242, 232)",
      text: "rgb(47, 41, 35)",
      accent: "rgb(126, 58, 47)",
    });
  });
  it("resolves common Typora variables and prefers link colors over headings", () => {
    expect(
      markdownThemeColors(`
      :root { --paper: #121212; --bg-color: var(--paper); --text-color: #eeeeee; }
      h1 { color: red; }
      a:hover { color: #00aacc !important; }
    `),
    ).toEqual({
      background: "rgb(18, 18, 18)",
      text: "rgb(238, 238, 238)",
      accent: "rgb(0, 170, 204)",
    });
    expect(
      markdownThemeColors(":root { --primary-color: var(--missing, red); }")
        .accent,
    ).toBe("red");
  });
  it("uses neutral colors for missing, context-dependent, cyclic, or unsupported values", () => {
    expect(
      markdownThemeColors(`
      @import url('https://example.invalid/theme.css');
      /* body { color: red; } */
      :root { --bg-color: var(--loop); --loop: var(--bg-color); }
      body { background: url('image.png'); color: inherit; }
      a { color: currentColor; }
    `),
    ).toEqual(GENERIC_MARKDOWN_THEME_COLORS);
    expect(markdownThemeColors("#write { font-size: 16px; }")).toEqual(
      GENERIC_MARKDOWN_THEME_COLORS,
    );
  });
});
