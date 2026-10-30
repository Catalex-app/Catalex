/** Shared entrance/exit motion for editor diagnostic and selection popups. */
export function animateEditorPopup(
  dom: HTMLElement,
  opening: boolean,
  previous: Animation | null,
  onFinish?: () => void,
): Animation | null {
  const current = getComputedStyle(dom);
  const from = {
    opacity: current.opacity,
  };
  previous?.cancel();
  const to = {
    opacity: opening ? "1" : "0",
  };
  dom.style.opacity = to.opacity;
  dom.style.pointerEvents = opening ? "" : "none";
  dom.inert = !opening;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    onFinish?.();
    return null;
  }
  const animation = dom.animate([from, to], {
    duration:
      Number.parseFloat(current.getPropertyValue("--popup-fade-duration")) ||
      200,
    easing:
      current.getPropertyValue("--popup-fade-easing").trim() ||
      "cubic-bezier(0.2, 0, 0.2, 1)",
  });
  animation.onfinish = () => onFinish?.();
  return animation;
}
