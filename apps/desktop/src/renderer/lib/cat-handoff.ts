/** Carry the rendered onboarding cat into its actual sidebar position. */
export function finishWithCatHandoff(finish: () => void) {
  const source = document.querySelector<HTMLElement>(
    '[aria-label="Cat preview"] [data-cat-companion]',
  );
  if (
    !source ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    finish();
    return;
  }
  const bounds = source.getBoundingClientRect();
  const sourceWidth = source.offsetWidth;
  const clone = source.cloneNode(true) as HTMLElement;
  clone.removeAttribute("data-cat-companion");
  clone.setAttribute("aria-hidden", "true");
  const overlay = document.createElement("div");
  overlay.setAttribute("data-cat-handoff", "");
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${source.offsetWidth}px`,
    height: `${source.offsetHeight}px`,
    transformOrigin: "top left",
    pointerEvents: "none",
    zIndex: "10000",
  });
  overlay.style.transform = `scale(${bounds.width / sourceWidth})`;
  overlay.append(clone);
  document.body.append(overlay);
  const mask = document.createElement("style");
  mask.textContent = "[data-cat-companion] { visibility: hidden !important; }";
  document.head.append(mask);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    overlay.remove();
    mask.remove();
  };
  const watchdog = window.setTimeout(cleanup, 2200);
  finish();
  const started = performance.now();
  const findDestination = () => {
    if (cleaned) return;
    const target = Array.from(
      document.querySelectorAll<HTMLElement>("[data-cat-companion]"),
    ).find(
      (el) =>
        !el.closest('[data-testid="onboarding"]') &&
        el.getBoundingClientRect().width > 0,
    );
    if (!target && performance.now() - started < 500) {
      requestAnimationFrame(findDestination);
      return;
    }
    const destination = target?.getBoundingClientRect();
    const fromScale = bounds.width / sourceWidth;
    const animations: Animation[] = [];
    if (destination) {
      const toScale = destination.width / sourceWidth;
      // One progress curve keeps every point on the cat on a straight path.
      // Inspired by the chat drawer reveal, with a gentler overshoot.
      animations.push(
        overlay.animate(
          [
            { transform: `translate(0, 0) scale(${fromScale})` },
            {
              transform: `translate(${destination.left - bounds.left}px, ${destination.top - bounds.top}px) scale(${toScale})`,
            },
          ],
          {
            duration: 700,
            easing: "cubic-bezier(0.18, 1.06, 0.24, 1)",
            fill: "forwards",
          },
        ),
      );
    } else {
      animations.push(
        overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 200,
          easing: "ease-out",
          fill: "forwards",
        }),
      );
    }
    void Promise.all(animations.map((animation) => animation.finished))
      .catch(() => {})
      .finally(() => {
        clearTimeout(watchdog);
        cleanup();
      });
  };
  requestAnimationFrame(findDestination);
}
