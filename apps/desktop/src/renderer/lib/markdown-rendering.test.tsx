import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import {
  markdownFormatting,
  markdownFragment,
  markdownHtmlSchema,
  markdownLinkPosition,
} from "./markdown-rendering";
import { markdownFileLink } from "./markdown";
import { markdownCodeHighlighting } from "./markdown-code-highlighting";

const render = (source: string) =>
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[
        rehypeRaw,
        [rehypeSanitize, markdownHtmlSchema],
        markdownFormatting,
        rehypeKatex,
        markdownCodeHighlighting,
      ]}
    >
      {source}
    </ReactMarkdown>,
  );

describe("Markdown locations", () => {
  it("matches formatted, duplicate, Unicode, and setext headings", () => {
    const source =
      "# A *heading*\n\n# A heading\n\n你好\n----\n\n```md\n# fake\n```";
    expect(markdownLinkPosition(source, "a-heading")).toBe(0);
    expect(markdownLinkPosition(source, "a-heading-1")).toBe(
      source.indexOf("# A heading"),
    );
    expect(markdownLinkPosition(source, "你好")).toBe(source.indexOf("你好"));
    expect(markdownLinkPosition(source, "fake")).toBeNull();
    expect(render(source)).toContain('id="catalex-anchor-a-heading-1"');
  });
  it("resolves HTML ids, named anchors, encoded fragments and line locations", () => {
    const source =
      'first\n\n<span id="color">Colored</span>\n\n<a name="old"></a>';
    expect(markdownLinkPosition(source, "color")).toBe(source.indexOf("<span"));
    expect(markdownLinkPosition(source, "old")).toBe(source.indexOf("<a"));
    expect(markdownLinkPosition(source, "L3C3-L4")).toBe(9);
    expect(markdownLinkPosition(source, "L0")).toBeNull();
    expect(markdownLinkPosition(source, "L999")).toBeNull();
    expect(markdownFragment("?mode=1#%E4%BD%A0%E5%A5%BD")).toBe("你好");
  });
});

describe("Markdown HTML", () => {
  it("preserves colors, details, tables and math", () => {
    const result = render(
      '<span style="color: red; background-color: #ffeebb; font-weight: bold">Colored</span>\n\n<details><summary>More</summary>Body</details>\n\n<table><tr><td>Cell</td></tr></table>\n\n$E=mc^2$',
    );
    expect(result).toContain(
      'style="color:red;background-color:#ffeebb;font-weight:bold"',
    );
    expect(result).toContain("<details><summary>More</summary>Body</details>");
    expect(result).toContain("<td>Cell</td>");
    expect(result).toContain('class="katex"');
  });
  it("removes active HTML, event handlers, unsafe URLs and intrusive styles", () => {
    const result = render(
      '<script>alert(1)</script><iframe src="https://example.com"></iframe><style>body{display:none}</style><span onclick="bad()" style="color:blue;position:fixed;background-color:url(https://example.com)">Safe</span><a href="javascript:alert(1)">link</a>',
    );
    expect(result).not.toMatch(
      /<script|<iframe|<style|onclick|javascript:|position:fixed|url\(/,
    );
    expect(result).toContain('style="color:blue"');
  });
});

describe("file drop links", () => {
  it("creates escaped relative paths from nested directories", () => {
    expect(
      markdownFileLink("/project/docs/main.md", "/project/images/a [b]#1.png"),
    ).toBe("[a \\[b\\]#1.png](../images/a%20%5Bb%5D%231.png)");
    expect(
      markdownFileLink("C:\\project\\main.md", "C:\\project\\notes.md"),
    ).toBe("[notes.md](notes.md)");
    expect(markdownFileLink("C:\\project\\main.md", "D:\\notes.md")).toBeNull();
  });
});

describe("Markdown code highlighting", () => {
  it.each([
    ["js", 'const message = "hello";'],
    ["ts", "const count: number = 42;"],
    ["python", 'def greet():\n    return "hello"'],
    ["json", '{"count": 42}'],
    ["bash", 'echo "$HOME"'],
    ["r", "mean(c(1, 2, 3))"],
    ["rust", "fn main() { let count = 42; }"],
    ["latex", "\\section{Introduction}"],
    ["tex", "\\textbf{Hello}"],
  ])("highlights %s fences", (language, code) => {
    const result = render(`\`\`\`${language}\n${code}\n\`\`\``);
    expect(result).toContain(`language-${language}`);
    expect(result).toMatch(/<span class="hljs-/);
  });

  it.each([
    "",
    "text",
    "unknown-language",
    "mermaid",
  ])("keeps %s fences readable without guessing a language", (language) => {
    const result = render(
      `\`\`\`${language}\nconst x = 1;\n  indented\n\`\`\``,
    );
    expect(result).not.toContain('<span class="hljs-');
    expect(result).toContain("const x = 1;\n  indented\n</code>");
  });

  it("preserves literal HTML in code and keeps inline code and math separate", () => {
    const result = render(
      '`const inline = 1`\n\n```html\n<script>alert("x")</script>\n```\n\n```math\nx^2\n```\n\n$x^2$',
    );
    expect(result).toContain("<code>const inline = 1</code>");
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;");
    expect(result).toContain('class="katex-display"');
    expect(result.match(/class="katex"/g)).toHaveLength(2);
  });

  it("leaves raw HTML code markup intact for source-mapped comments", () => {
    const source = '<pre><code class="language-js">const x = 1;</code></pre>';
    expect(render(source)).toBe(source);
  });
});
