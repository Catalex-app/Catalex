// IntersectionObserver percentage margins use width, not viewport height.
export function pdfPageObserverRootMargin(viewportHeight: number): string {
  return `${viewportHeight}px 0px`;
}

export function pdfPageRenderKey(docId: number, pageIndex: number): string {
  return `${docId}:${pageIndex}`;
}
