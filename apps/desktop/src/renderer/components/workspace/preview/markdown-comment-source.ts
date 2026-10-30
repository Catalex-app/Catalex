interface SourceNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: SourceNode[];
}

/** Preserve exact text positions before KaTeX replaces math with generated DOM. */
export function markdownCommentSource() {
  return (tree: SourceNode) => {
    const visit = (parent: SourceNode) => {
      parent.children = parent.children?.map((node) => {
        if (node.type === "text" && node.position && node.value) {
          return {
            type: "element",
            tagName: "span",
            properties: {
              "data-comment-start": node.position.start.offset,
              "data-comment-end": node.position.end.offset,
            },
            children: [node],
          };
        }
        if (node.children) visit(node);
        return node;
      });
    };
    visit(tree);
  };
}

/** Map decoded entities and Markdown escapes back to their source boundaries. */
export function markdownTextOffsets(element: HTMLElement, source: string) {
  const from = Number(element.dataset.commentStart);
  const to = Number(element.dataset.commentEnd);
  const raw = source.slice(from, to);
  const rendered = element.textContent ?? "";
  if (raw === rendered)
    return Array.from({ length: rendered.length + 1 }, (_, i) => from + i);
  const decoder = element.ownerDocument.createElement("textarea");
  const offsets = [from];
  let output = "";
  for (let i = 0; i < raw.length; ) {
    const start = i;
    let value = raw[i++];
    if (value === "&") {
      const entity = raw
        .slice(start)
        .match(/^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i)?.[0];
      if (entity) {
        decoder.innerHTML = entity;
        value = decoder.value;
        i = start + entity.length;
      }
    } else if (
      value === "\\" &&
      raw[i] &&
      /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(raw[i])
    ) {
      value = raw[i++];
    } else if (value === "\r" && raw[i] === "\n") {
      value = "\n";
      i++;
    }
    output += value;
    for (let j = 0; j < value.length; j++)
      offsets.push(j === value.length - 1 ? from + i : from + start);
  }
  return output === rendered ? offsets : null;
}

export function markdownSelectionRange(selection: Selection, source: string) {
  if (selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const endpoint = (node: Node, offset: number) => {
    const element = (
      node.nodeType === 1 ? (node as Element) : node.parentElement
    )?.closest<HTMLElement>("[data-comment-start]");
    if (!element) return null;
    const offsets = markdownTextOffsets(element, source);
    if (!offsets) return null;
    const prefix = element.ownerDocument.createRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(node, offset);
    return offsets[prefix.toString().length] ?? null;
  };
  const from = endpoint(range.startContainer, range.startOffset);
  const to = endpoint(range.endContainer, range.endOffset);
  if (
    from === null ||
    to === null ||
    from >= to ||
    !selection.toString().trim()
  )
    return null;
  return { from, to, line: source.slice(0, from).split("\n").length };
}
