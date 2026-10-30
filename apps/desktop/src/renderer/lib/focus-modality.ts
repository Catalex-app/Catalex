/** Track input intent without changing focus ownership or tab order. */
export function installFocusModality() {
  const root = document.documentElement;
  const onPointerDown = () => {
    root.dataset.inputModality = "pointer";
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing)
      return;
    root.dataset.inputModality = "keyboard";
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    delete root.dataset.inputModality;
  };
}
