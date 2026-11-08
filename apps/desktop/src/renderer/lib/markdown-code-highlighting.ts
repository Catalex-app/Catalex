import latex from "highlight.js/lib/languages/latex";
import { common } from "lowlight";
import rehypeHighlight from "rehype-highlight";

/** Highlight explicit code languages; unknown and unlabeled fences stay plain. */
export function markdownCodeHighlighting() {
  const highlight = rehypeHighlight({
    languages: { ...common, latex },
    detect: false,
  });
  return (...[tree, file]: Parameters<typeof highlight>) => {
    const visit = (node: typeof tree | (typeof tree.children)[number]) => {
      if (node.type === "element" && node.tagName === "pre") {
        // Markdown fences have unpositioned text children. Raw HTML can contain
        // source annotations for comments; leave that existing markup intact.
        if (
          node.children.some(
            (child) =>
              child.type === "element" &&
              child.tagName === "code" &&
              child.children.every(
                (text) => text.type === "text" && !text.position,
              ),
          )
        )
          highlight({ type: "root", children: [node] }, file);
        return;
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
  };
}
