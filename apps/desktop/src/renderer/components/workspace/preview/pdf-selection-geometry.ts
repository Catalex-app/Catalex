/** Measure glyphs once in SVG coordinates, then follow scroll/zoom transforms.
 * WebKit's Range rectangles for SVG text can omit the text's x/y offset.
 */
export interface PdfSelectionFragment {
  element: SVGTextElement;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function pdfSelectionFragments(range: Range, viewport: HTMLElement) {
  const fragments: PdfSelectionFragment[] = [];
  for (const element of viewport.querySelectorAll<SVGTextElement>(
    ".mupdf-text-layer text",
  )) {
    const node = element.firstChild;
    if (!node || !range.intersectsNode(node)) continue;
    const start = range.startContainer === node ? range.startOffset : 0;
    const end =
      range.endContainer === node
        ? range.endOffset
        : (node.textContent?.length ?? 0);
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (
      let index = start;
      index < Math.min(end, element.getNumberOfChars());
      index++
    ) {
      const rect = element.getExtentOfChar(index);
      left = Math.min(left, rect.x);
      top = Math.min(top, rect.y);
      right = Math.max(right, rect.x + rect.width);
      bottom = Math.max(bottom, rect.y + rect.height);
    }
    // WebKit also reports unadjusted glyph widths for lengthAdjust, while
    // Chromium includes textLength in its computed length and glyph extents.
    const computedLength = element.getComputedTextLength();
    const adjustedLength = element.textLength.baseVal.value;
    if (Number.isFinite(left) && computedLength > 0 && adjustedLength > 0) {
      const origin = element.getBBox().x;
      const ratio = adjustedLength / computedLength;
      left = origin + (left - origin) * ratio;
      right = origin + (right - origin) * ratio;
    }
    if (Number.isFinite(left))
      fragments.push({ element, left, top, right, bottom });
  }
  return fragments;
}

export function measurePdfSelection(range: Range, viewport: HTMLElement) {
  const fragments = pdfSelectionFragments(range, viewport);
  return (): DOMRect | null => {
    if (!viewport.isConnected || !fragments.length) return null;
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const fragment of fragments) {
      if (!fragment.element.isConnected) return null;
      const matrix = fragment.element.getScreenCTM();
      if (!matrix) return null;
      for (const x of [fragment.left, fragment.right]) {
        for (const y of [fragment.top, fragment.bottom]) {
          const screenX = matrix.a * x + matrix.c * y + matrix.e;
          const screenY = matrix.b * x + matrix.d * y + matrix.f;
          left = Math.min(left, screenX);
          top = Math.min(top, screenY);
          right = Math.max(right, screenX);
          bottom = Math.max(bottom, screenY);
        }
      }
    }
    return new DOMRect(left, top, right - left, bottom - top);
  };
}
