/** Fade only a visual copy, so Radix immediately releases its dismissal layer. */
export function prepareTooltipExit(content: HTMLElement) {
  if (
    !content.isConnected ||
    typeof content.animate !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return null;

  const wrapper = content.parentElement;
  if (!wrapper) return null;
  const style = getComputedStyle(content);
  const opacity = style.opacity;
  const transform = style.transform;
  const transformOrigin = style.transformOrigin;
  const snapshot = wrapper.cloneNode(false) as HTMLElement;
  const visual = content.cloneNode(true) as HTMLElement;
  snapshot.appendChild(visual);
  snapshot.removeAttribute("data-radix-popper-content-wrapper");
  snapshot.setAttribute("data-tooltip-exit", "");
  snapshot.setAttribute("aria-hidden", "true");
  snapshot.inert = true;
  snapshot.style.pointerEvents = "none";
  // Do not duplicate live tooltip identities or accessibility descriptions.
  for (const node of [snapshot, ...snapshot.querySelectorAll("*")]) {
    node.removeAttribute("id");
    node.removeAttribute("role");
    node.removeAttribute("aria-describedby");
    node.removeAttribute("data-slot");
  }
  visual.style.animation = "none";
  visual.style.pointerEvents = "none";
  visual.style.transformOrigin = transformOrigin;

  let animation: Animation | undefined;
  const cancel = () => {
    animation?.cancel();
    snapshot.remove();
  };
  const play = () => {
    // Ref detach also occurs during Strict Mode checks or ref replacement.
    if (content.isConnected) return;
    document.body.appendChild(snapshot);
    animation = visual.animate(
      [
        { opacity, transform },
        { opacity: 0, transform: "scale(0.97)" },
      ],
      { duration: 90, easing: "ease-out", fill: "forwards" },
    );
    void animation.finished.then(
      () => snapshot.remove(),
      () => snapshot.remove(),
    );
  };
  return { play, cancel };
}
