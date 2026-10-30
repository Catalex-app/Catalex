import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export type SpellingDocument = "latex" | "markdown" | "text";
export type SpellingWord = { from: number; to: number; text: string };

export function spellingDocument(path: string): SpellingDocument | null {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "tex" || extension === "ltx") return "latex";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "txt") return "text";
  return null;
}

// These are node names from the installed codemirror-lang-latex grammar.
// Only Normal leaves are prose; prune semantic arguments before reaching them.
const latexExcluded = new Set([
  "BibKeyArgument",
  "RefArgument",
  "LabelArgument",
  "PackageArgument",
  "DocumentClassArgument",
  "FilePathArgument",
  "BareFilePathArgument",
  "UrlArgument",
  "OptionalArgument",
  "DefinitionArgument",
  "TabularArgument",
  "UnknownCommand",
  "TextTeletypeCommand",
  "SetLength",
  "TheoremStyle",
  "DollarMath",
  "BracketMath",
  "ParenMath",
  "EquationEnvironment",
  "EquationArrayEnvironment",
  "VerbatimEnvironment",
  "TikzPictureEnvironment",
]);
const markdownExcluded = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "HTMLTag",
  "Autolink",
  "URL",
  "LinkReference",
  "LinkLabel",
  "ProcessingInstruction",
]);
const wordCharacter = /[\p{L}\p{N}_’']/u;

/** Bounded by rendered ranges, never scans or copies the entire document. */
export function proseWords(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  kind: SpellingDocument,
): SpellingWord[] {
  const words: SpellingWord[] = [];
  let remaining = 30000;
  const add = (start: number, end: number) => {
    if (remaining <= 0 || start >= end) return;
    const to = Math.min(end, start + remaining);
    remaining -= to - start;
    const text = state.doc.sliceString(start, to);
    for (const match of text.matchAll(/[\p{L}]+(?:['’][\p{L}]+)*/gu)) {
      const from = start + match.index!;
      const end = from + match[0].length;
      if (match[0].length > 100) continue;
      // Avoid checking half a clipped word, or parts of an identifier.
      if (from > 0 && wordCharacter.test(state.doc.sliceString(from - 1, from)))
        continue;
      if (
        end < state.doc.length &&
        wordCharacter.test(state.doc.sliceString(end, end + 1))
      )
        continue;
      words.push({ from, to: end, text: match[0].replace(/’/g, "'") });
    }
  };
  const tree = syntaxTree(state);
  for (const range of ranges) {
    if (remaining <= 0) break;
    if (kind === "text") {
      add(range.from, range.to);
      continue;
    }
    if (kind === "latex") {
      tree.iterate({
        from: range.from,
        to: range.to,
        enter(node) {
          if (latexExcluded.has(node.name)) return false;
          if (node.name === "Normal") {
            add(Math.max(range.from, node.from), Math.min(range.to, node.to));
            return false;
          }
        },
      });
    } else {
      let from = range.from;
      tree.iterate({
        from: range.from,
        to: range.to,
        enter(node) {
          if (markdownExcluded.has(node.name)) {
            add(from, Math.min(range.to, node.from));
            from = Math.max(from, node.to);
            return false;
          }
        },
      });
      add(from, range.to);
    }
  }
  return words;
}
