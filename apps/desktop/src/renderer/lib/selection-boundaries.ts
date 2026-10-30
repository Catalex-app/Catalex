/** Shell controls never invoke browser-wide Select All. Native editors retain
 * their own key handling; readable regions opt in at a shared content boundary. */
export function installSelectionBoundaries() {
  const keydown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      !(event.metaKey || event.ctrlKey) ||
      event.key.toLowerCase() !== "a"
    )
      return;
    const target = event.target instanceof Element ? event.target : null;
    if (
      target?.closest('input, textarea, [contenteditable="true"], .cm-editor')
    )
      return;
    if (target?.matches('[data-testid="pdf-scroll-container"]')) return;
    event.preventDefault();
    const selection = window.getSelection();
    const region = selection?.anchorNode?.parentElement?.closest(
      "[data-selectable-content], .selectable-content, .chat-markdown, .select-text, .cm-inlineCommentText, pre",
    );
    if (!region) return;
    const range = document.createRange();
    range.selectNodeContents(region);
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  document.addEventListener("keydown", keydown);
  return () => document.removeEventListener("keydown", keydown);
}
