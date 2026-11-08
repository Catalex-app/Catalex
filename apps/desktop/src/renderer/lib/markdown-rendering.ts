import GithubSlugger from "github-slugger";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

interface HtmlNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
  position?: { start: { offset?: number } };
}

const anchorPrefix = "catalex-anchor-";
export const markdownHtmlSchema: typeof defaultSchema = {
  ...defaultSchema,
  clobberPrefix: anchorPrefix,
  strip: [...(defaultSchema.strip ?? []), "style", "iframe", "object"],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "style"],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-./, "math-inline", "math-display"],
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ["className", "math-inline", "math-display"],
    ],
    font: ["color"],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), "font"],
};

// Keep text formatting, without CSS URLs, positioning, or document-wide styles.
export function markdownFormatting() {
  return (tree: HtmlNode) => {
    const slugger = new GithubSlugger();
    const text = (node: HtmlNode): string =>
      node.type === "text"
        ? (node.value ?? "")
        : node.tagName === "img"
          ? String(node.properties?.alt ?? "")
          : (node.children ?? []).map(text).join("");
    const visit = (node: HtmlNode) => {
      if (node.type === "element") {
        const props = (node.properties ??= {});
        if (/^h[1-6]$/.test(node.tagName ?? "") && !props.id) {
          props.id = anchorPrefix + slugger.slug(text(node));
        }
        if (typeof props.style === "string") {
          props.style = props.style
            .split(";")
            .filter((declaration) => {
              const colon = declaration.indexOf(":");
              const name = declaration.slice(0, colon).trim().toLowerCase();
              const value = declaration.slice(colon + 1).trim();
              return (
                /^(color|background-color|font-size|font-weight|font-style|font-family|text-align|text-decoration|vertical-align|white-space)$/.test(
                  name,
                ) &&
                /^[\w\s#.,%()'"+/-]+$/.test(value) &&
                !/url\s*\(|expression\s*\(|var\s*\(/i.test(value)
              );
            })
            .join(";");
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export function markdownFragment(suffix: string): string | null {
  const index = suffix.indexOf("#");
  if (index < 0) return null;
  try {
    return decodeURIComponent(suffix.slice(index + 1));
  } catch {
    return suffix.slice(index + 1);
  }
}

export function markdownAnchorId(fragment: string) {
  return anchorPrefix + fragment;
}

export function markdownLinkPosition(
  source: string,
  fragment: string,
): number | null {
  if (!fragment) return 0;
  const line = /^L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(fragment);
  if (line) {
    const lines = source.split("\n");
    const index = Number(line[1]) - 1;
    if (index < 0 || index >= lines.length) return null;
    return (
      lines.slice(0, index).reduce((sum, text) => sum + text.length + 1, 0) +
      Math.min(lines[index].length, Math.max(0, Number(line[2] ?? 1) - 1))
    );
  }
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, markdownHtmlSchema)
    .use(markdownFormatting);
  const tree = processor.runSync(processor.parse(source)) as HtmlNode;
  let position: number | null = null;
  const visit = (node: HtmlNode) => {
    if (position !== null) return;
    if (
      node.properties?.id === markdownAnchorId(fragment) ||
      node.properties?.name === markdownAnchorId(fragment)
    )
      position = node.position?.start.offset ?? null;
    node.children?.forEach(visit);
  };
  visit(tree);
  return position;
}
