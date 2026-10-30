import { markdownLanguage } from "@codemirror/lang-markdown";

type MarkdownSyntaxNode = ReturnType<
  ReturnType<typeof markdownLanguage.parser.parse>["resolve"]
>;

export interface OutlineItem {
  level: number;
  number: string;
  title: string;
  line: number;
}

export type DocumentOutlineFormat = "latex" | "markdown";

function stripLatexComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") continue;
    let backslashCount = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) {
      backslashCount++;
    }
    if (backslashCount % 2 === 0) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseLatexOutline(content: string): OutlineItem[] {
  const lines = content.split("\n");
  const outline: OutlineItem[] = [];
  const sectionRegex =
    /\\(section|subsection|subsubsection|chapter|part)\*?\s*\{([^}]*)\}/;
  const levelMap: Record<string, number> = {
    part: 0,
    chapter: 1,
    section: 2,
    subsection: 3,
    subsubsection: 4,
  };
  const counters = [0, 0, 0, 0, 0];

  lines.forEach((line, index) => {
    const match = stripLatexComment(line).match(sectionRegex);
    if (!match) return;

    const [, type, title] = match;
    const level = levelMap[type] ?? 2;
    counters[level] += 1;
    for (let i = level + 1; i < counters.length; i++) {
      counters[i] = 0;
    }
    outline.push({
      level,
      number: counters.filter((count) => count > 0).join("."),
      title: title.trim(),
      line: index + 1,
    });
  });

  return outline;
}

interface TextEdit {
  from: number;
  to: number;
  replacement: string;
}

function decodeCommonHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };

  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|(amp|apos|gt|lt|quot));/gi,
    (entity, decimal: string, hexadecimal: string, named: string) => {
      const codePoint = decimal
        ? Number.parseInt(decimal, 10)
        : hexadecimal
          ? Number.parseInt(hexadecimal, 16)
          : Number.NaN;
      if (Number.isFinite(codePoint)) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return entity;
        }
      }
      return namedEntities[named.toLowerCase()] ?? entity;
    },
  );
}

function markdownHeadingTitle(
  content: string,
  heading: MarkdownSyntaxNode,
): string {
  const source = content.slice(heading.from, heading.to);
  const edits: TextEdit[] = [];
  const cursor = heading.cursor();

  const visitChildren = () => {
    if (!cursor.firstChild()) return;
    do {
      const { name, from, to } = cursor;
      const parentName = cursor.node.parent?.name;
      if (
        name === "HeaderMark" ||
        name === "EmphasisMark" ||
        name === "CodeMark" ||
        name === "LinkMark" ||
        name === "HTMLTag" ||
        (name === "URL" && (parentName === "Link" || parentName === "Image"))
      ) {
        edits.push({
          from: from - heading.from,
          to: to - heading.from,
          replacement: "",
        });
      } else if (name === "Escape") {
        edits.push({
          from: from - heading.from,
          to: to - heading.from,
          replacement: content.slice(from, to).slice(1),
        });
      } else {
        visitChildren();
      }
    } while (cursor.nextSibling());
    cursor.parent();
  };

  visitChildren();

  let title = source;
  edits.sort((a, b) => b.from - a.from);
  for (const edit of edits) {
    title = `${title.slice(0, edit.from)}${edit.replacement}${title.slice(edit.to)}`;
  }

  return decodeCommonHtmlEntities(title).replace(/\s+/g, " ").trim();
}

function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineNumberAtOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return high + 1;
}

function parseMarkdownOutline(content: string): OutlineItem[] {
  const outline: OutlineItem[] = [];
  const lineStarts = buildLineStarts(content);
  const tree = markdownLanguage.parser.parse(content);

  tree.iterate({
    enter(node) {
      const headingMatch = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(
        node.name,
      );
      if (!headingMatch) return;

      const level = Number.parseInt(headingMatch[1], 10);
      outline.push({
        level,
        number: "",
        title: markdownHeadingTitle(content, node.node),
        line: lineNumberAtOffset(lineStarts, node.from),
      });
    },
  });

  return outline;
}

export function parseDocumentOutline(
  content: string,
  format: DocumentOutlineFormat,
): OutlineItem[] {
  return format === "markdown"
    ? parseMarkdownOutline(content)
    : parseLatexOutline(content);
}

export function indexOutlinePositions(content: string, outline: OutlineItem[]) {
  const starts = buildLineStarts(content);
  return outline.map((item) => ({
    line: item.line,
    offset: starts[item.line - 1] ?? content.length,
  }));
}

// Searching visible headings naturally selects a collapsed ancestor for hidden descendants.
export function findCurrentOutlineLine(
  index: Array<{ line: number; offset: number }>,
  cursor: number,
): number | null {
  let low = 0;
  let high = index.length - 1;
  let current: number | null = null;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (index[middle].offset <= cursor) {
      current = index[middle].line;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return current;
}
