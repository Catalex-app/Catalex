/** Ordinary actions belong to the primary button. Keep context menus on their
 * separate event and allow middle clicks only on explicit tab/link targets. */
export function installMouseBoundary(doc: Document = document) {
  const owner = doc.defaultView;
  if (!owner) return () => {};

  const block = (event: MouseEvent) => {
    const contextClick =
      event.button === 0 &&
      event.ctrlKey &&
      /Mac/.test(owner.navigator.platform);
    if (event.button === 0 && !contextClick) return;
    const target = event.target as Element | null;
    if (event.type === "auxclick" && event.button === 1) {
      if (target?.closest?.("[data-middle-click-tab], a[href]")) return;
    }
    event.preventDefault();
    // Capture on the owning window, before document listeners, React, and native
    // focus/selection handling. Contextmenu and keyboard events remain separate.
    event.stopImmediatePropagation();
  };
  const types = [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
    "dblclick",
    "auxclick",
  ] as const;
  for (const type of types) owner.addEventListener(type, block, true);
  return () => {
    for (const type of types) owner.removeEventListener(type, block, true);
  };
}
