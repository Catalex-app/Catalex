import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { markdownFormatting, markdownHtmlSchema } from "./markdown-rendering";
import { markdownCommentSource } from "@/components/workspace/preview/markdown-comment-source";
import { markdownCodeHighlighting } from "./markdown-code-highlighting";
import markdownMathjax from "./markdown-mathjax";

const render = (source: string) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[
        rehypeRaw,
        [rehypeSanitize, markdownHtmlSchema],
        markdownFormatting,
        markdownCommentSource,
        markdownMathjax,
        markdownCodeHighlighting,
      ]}
    >
      {source}
    </ReactMarkdown>,
  );

describe("Markdown MathJax", () => {
  it("renders inline, aligned display, and fenced math as self-contained SVG", () => {
    const html = render(
      "$\\frac{a}{b}$\n\n$$\n\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}\n$$\n\n```math\n\\mathbb{R}\n```",
    );
    expect(html.match(/<mjx-container /g)).toHaveLength(3);
    expect(html.match(/<svg /g)).toHaveLength(3);
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelector('[data-mml-node="merror"]')).toBeNull();
    expect(html).not.toMatch(/<script|<link|<use|font-face/);
  });
  it("renders malformed math without losing surrounding prose", () => {
    const html = render("Before $\\frac{$ after.");
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.textContent).toContain("Before ");
    expect(container.textContent).toContain(" after.");
    expect(container.querySelector('[data-mml-node="merror"]')).not.toBeNull();
  });
  it("does not turn TeX into active links or HTML styling", () => {
    const html = render(
      "$\\href{javascript:alert(1)}{x}$ and $\\style{position:fixed}{y}$",
    );
    expect(html).not.toMatch(/<a\b|href="javascript:|style="position:fixed/);
  });
  it("does not leak document macros into another render", () => {
    const before = render("$\\privateword$");
    render("$\\newcommand{\\privateword}{x}\\privateword$");
    expect(render("$\\privateword$")).toBe(before);
  });
  it("supports document macros, matrices, and the configured notation packages", () => {
    const html = render(
      "$\\newcommand{\\vect}[1]{\\boldsymbol{#1}}\\vect{x}$\n\n$$\n\\begin{pmatrix}1 & 2 \\\\ 3 & 4\\end{pmatrix} + \\cancel{x} + \\coloneqq + \\vect{y}\n$$",
    );
    expect(html.match(/<mjx-container /g)).toHaveLength(2);
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(
      container.querySelector(
        '[data-mml-node="merror"], .mathjax-error, [mathcolor="red"]',
      ),
    ).toBeNull();
  });
  it("bounds recursive macro expansion and still renders the next equation", () => {
    const html = render("$\\def\\loop{\\loop}\\loop$\n\nAfter $x^2$.");
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelectorAll('[data-mml-node="merror"]')).toHaveLength(
      1,
    );
    expect(container.querySelectorAll("mjx-container")).toHaveLength(2);
    expect(container.textContent).toContain("After ");
  });
});
