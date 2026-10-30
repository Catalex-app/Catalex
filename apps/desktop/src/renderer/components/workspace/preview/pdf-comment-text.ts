import katex from "katex";

// An opaque TeX command separates independently matchable visible text. Never
// substitute macro arguments (citation keys, labels, etc.) for rendered output.
export const PDF_TEXT_GAP = "\ufffc";
const visibleTextCache = new Map<string, string | null>();

const SYMBOL_EQUIVALENTS: Record<string, string> = {
  "⋅": "·",
  "∣": "|",
  "⋃": "∪",
  "⋂": "∩",
  "‘": "'",
  "’": "'",
  "`": "'",
  "“": '"',
  "”": '"',
};

/** Compare typeset text while retaining both ends of each original span. */
export function normalizePdfCommentText(text: string) {
  const offsets: number[] = [];
  const ends: number[] = [];
  let value = "";
  for (let i = 0; i < text.length; ) {
    const start = i;
    let token = String.fromCodePoint(text.codePointAt(i)!);
    i += token.length;
    // TeX's paired quotes produce one PDF glyph.
    if ((token === "`" || token === "'") && text[i] === token) {
      token = '"';
      i++;
    }
    for (const char of token.normalize("NFKC")) {
      if (/\s|[\u00ad-]/u.test(char)) continue;
      const equivalent = SYMBOL_EQUIVALENTS[char] ?? char;
      value += equivalent;
      for (let j = 0; j < equivalent.length; j++) {
        offsets.push(start);
        ends.push(i);
      }
    }
  }
  return { value, offsets, ends };
}

function mathVisibleText(source: string): string | null {
  try {
    const markup = katex.renderToString(source, {
      output: "mathml",
      throwOnError: true,
      strict: "ignore",
    });
    const doc = new DOMParser().parseFromString(markup, "text/html");
    const math = doc.querySelector("math");
    if (!math) return null;
    const visible = (node: Element): string => {
      if (node.localName === "annotation") return "";
      const children = [...node.children];
      // PDF extraction places superscripts before subscripts. MathML stores
      // the subscript first in msubsup, so use visual order for matching.
      if (node.localName === "msubsup")
        return [children[0], children[2], children[1]].map(visible).join("");
      return children.length
        ? children.map(visible).join("")
        : (node.textContent ?? "");
    };
    return visible(math);
  } catch {
    return null;
  }
}

// A conservative projection of common TeX text constructs, not a TeX engine.
// Unknown macros (especially references/citations) cannot be inferred from source.
const TEXT_COMMANDS = new Set([
  "textbf",
  "textit",
  "textsl",
  "textsc",
  "textrm",
  "textsf",
  "texttt",
  "textnormal",
  "emph",
  "underline",
  "mbox",
  "hbox",
  "text",
  "ensuremath",
  "mathrm",
  "mathbf",
  "mathit",
  "mathsf",
  "mathtt",
  "operatorname",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "caption",
]);
const DECLARATIONS = new Set([
  "bfseries",
  "itshape",
  "slshape",
  "scshape",
  "rmfamily",
  "sffamily",
  "ttfamily",
  "normalfont",
  "em",
  "bf",
  "it",
  "rm",
  "sf",
  "tt",
  "small",
  "large",
  "Large",
]);

export function pdfCommentVisibleText(source: string): string | null {
  if (visibleTextCache.has(source)) return visibleTextCache.get(source)!;
  const result = projectVisibleText(source)?.text ?? null;
  visibleTextCache.set(source, result);
  if (visibleTextCache.size > 500)
    visibleTextCache.delete(visibleTextCache.keys().next().value!);
  return result;
}

export interface PdfCommentTextProjection {
  text: string;
  starts: number[];
  ends: number[];
}

/** Visible text with original source spans, including enclosing text commands. */
export function projectVisibleText(
  source: string,
): PdfCommentTextProjection | null {
  let output = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const append = (text: string, from: number, to: number) => {
    output += text;
    for (let j = 0; j < text.length; j++) {
      starts.push(from);
      ends.push(to);
    }
  };
  const result = () => ({ text: output, starts, ends });
  // A selection may start inside an equation, without its surrounding $ signs.
  if (!source.includes("$") && /(?<!\\)[_^]/.test(source)) {
    const visible = mathVisibleText(source);
    if (visible != null) {
      append(visible, 0, source.length);
      return result();
    }
  }
  const lists: Array<{ name: string; count: number }> = [];
  let i = 0;
  const group = (open = "{", close = "}"): string | null => {
    while (/\s/.test(source[i] ?? "") && i < source.length) i++;
    if (source[i] !== open) return null;
    const start = ++i;
    let depth = 1;
    while (i < source.length) {
      const char = source[i++];
      if (char === "\\") {
        i++;
        continue;
      }
      if (char === open) depth++;
      if (char === close && --depth === 0) return source.slice(start, i - 1);
    }
    return null;
  };
  while (i < source.length) {
    const tokenStart = i;
    const char = source[i++];
    if (char === "%") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (char === "$") {
      const delimiter = source[i] === "$" ? "$$" : "$";
      if (delimiter.length === 2) i++;
      const end = source.indexOf(delimiter, i);
      if (end >= 0) {
        append(
          mathVisibleText(source.slice(i, end)) ?? PDF_TEXT_GAP,
          tokenStart,
          end + delimiter.length,
        );
        i = end + delimiter.length;
      } else {
        append(
          mathVisibleText(source.slice(i)) ?? PDF_TEXT_GAP,
          tokenStart,
          source.length,
        );
        i = source.length;
      }
      continue;
    }
    if (char === "{" || char === "}") continue;
    if (char === "~") {
      append(" ", tokenStart, i);
      continue;
    }
    // Text-mode TeX ligatures: retain the whole source sequence for a
    // selection of the single rendered dash. Math is handled above.
    if (char === "-" && source[i] === "-") {
      i++;
      const emDash = source[i] === "-";
      if (emDash) i++;
      append(emDash ? "—" : "–", tokenStart, i);
      continue;
    }
    if (char !== "\\") {
      append(char, tokenStart, i);
      continue;
    }
    const escaped = source[i];
    if (escaped == null) {
      append(PDF_TEXT_GAP, tokenStart, i);
      break;
    }
    if ("%$&#_{}".includes(escaped)) {
      append(escaped, tokenStart, i + 1);
      i++;
      continue;
    }
    if (" ,;:!\\".includes(escaped)) {
      append(" ", tokenStart, i);
      i++;
      continue;
    }
    if ("([".includes(escaped)) {
      const close = escaped === "(" ? "\\)" : "\\]";
      const end = source.indexOf(close, i + 1);
      append(
        mathVisibleText(source.slice(i + 1, end < 0 ? source.length : end)) ??
          PDF_TEXT_GAP,
        tokenStart,
        end < 0 ? source.length : end + close.length,
      );
      i = end < 0 ? source.length : end + close.length;
      continue;
    }
    if (")]".includes(escaped)) {
      i++;
      continue;
    }
    const command = source.slice(i).match(/^[A-Za-z]+/)?.[0];
    if (!command) {
      append(PDF_TEXT_GAP, tokenStart, i);
      i++;
      group();
      continue;
    }
    i += command.length;
    if (command === "textemdash" || command === "textendash") {
      append(command === "textemdash" ? "—" : "–", tokenStart, i);
      continue;
    }
    if (command === "dots" || command === "ldots") {
      append("…", tokenStart, i);
      continue;
    }
    if (command === "begin" || command === "end") {
      const name = group();
      if (name === "enumerate" || name === "itemize") {
        if (command === "begin") lists.push({ name, count: 0 });
        else if (lists[lists.length - 1]?.name === name) lists.pop();
        append(" ", tokenStart, i);
      } else append(PDF_TEXT_GAP, tokenStart, i);
      continue;
    }
    if (command === "item") {
      const list = lists[lists.length - 1];
      if (list) list.count++;
      const label = group("[", "]");
      // Only infer standard top-level numbering; custom/nested labels need
      // evidence from the PDF rather than an invented counter format.
      if (label !== null) append(label, tokenStart, i);
      else if (list?.name === "enumerate" && lists.length === 1)
        append(`${list.count}. `, tokenStart, i);
      else if (list?.name === "itemize" && lists.length === 1)
        append("• ", tokenStart, i);
      else append(PDF_TEXT_GAP, tokenStart, i);
      continue;
    }
    if (DECLARATIONS.has(command)) {
      while (i < source.length && /\s/.test(source[i])) i++;
      continue;
    }
    if (command === "href" || command === "textcolor") {
      if (group() == null) {
        append(PDF_TEXT_GAP, tokenStart, i);
        continue;
      }
    } else if (!TEXT_COMMANDS.has(command)) {
      if (source[i] === "*") i++;
      while (i < source.length) {
        while (i < source.length && /\s/.test(source[i])) i++;
        if (source[i] === "[") {
          if (group("[", "]") == null) break;
        } else if (source[i] === "{") {
          if (group() == null) break;
        } else break;
      }
      append(PDF_TEXT_GAP, tokenStart, i);
      continue;
    }
    if (source[i] === "*") i++;
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] === "[" && group("[", "]") == null) {
      append(PDF_TEXT_GAP, tokenStart, i);
      continue;
    }
    const argument = group();
    if (argument == null) {
      append(PDF_TEXT_GAP, tokenStart, i);
      continue;
    }
    const projected = projectVisibleText(argument);
    if (!projected) {
      append(PDF_TEXT_GAP, tokenStart, i);
      continue;
    }
    const argumentStart = i - argument.length - 1;
    output += projected.text;
    for (let index = 0; index < projected.text.length; index++) {
      starts.push(
        index === 0 ? tokenStart : argumentStart + projected.starts[index],
      );
      ends.push(
        index === projected.text.length - 1
          ? i
          : argumentStart + projected.ends[index],
      );
    }
  }
  return output.split(PDF_TEXT_GAP).some((part) => part.trim())
    ? result()
    : null;
}
