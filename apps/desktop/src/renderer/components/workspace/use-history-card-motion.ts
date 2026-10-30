import { useLayoutEffect, useRef, type RefObject } from "react";

type Direction = "older" | "newer";

/** Keep the outgoing rendered card visible while the next version takes its place. */
export function useHistoryCardMotion(
  cardRef: RefObject<HTMLElement | null>,
  identity: string,
) {
  const pending = useRef<{
    ghost: HTMLElement;
    direction: Direction;
    sourceIdentity: string;
    rearPositions: Map<string, { transform: string; opacity: string }>;
  } | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  function prepare(direction: Direction) {
    cleanup.current?.();
    pending.current?.ghost.remove();
    pending.current = null;
    const card = cardRef.current;
    if (!card || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    const deck = card.parentElement;
    if (!deck) return;
    // A visual copy preserves the actual editor, media, scroll and footer,
    // without mounting another editor/PDF worker or exposing duplicate controls.
    const ghost = card.cloneNode(true) as HTMLElement;
    ghost.querySelectorAll("[id], [data-testid]").forEach((node) => {
      node.removeAttribute("id");
      node.removeAttribute("data-testid");
    });
    ghost.removeAttribute("data-testid");
    ghost.removeAttribute("id");
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    ghost.classList.add("history-transition-card");
    Object.assign(ghost.style, {
      position: "absolute",
      top: `${card.offsetTop}px`,
      left: `${card.offsetLeft}px`,
      width: `${card.offsetWidth}px`,
      height: `${card.offsetHeight}px`,
      margin: "0",
      animation: "none",
      pointerEvents: "none",
      zIndex: direction === "older" ? "3" : "1",
    });
    deck.append(ghost);
    const originals = [card, ...card.querySelectorAll<HTMLElement>("*")];
    const copies = [ghost, ...ghost.querySelectorAll<HTMLElement>("*")];
    originals.forEach((original, index) => {
      const copy = copies[index];
      if (original.scrollTop) copy.scrollTop = original.scrollTop;
      if (original.scrollLeft) copy.scrollLeft = original.scrollLeft;
      if (
        original instanceof HTMLCanvasElement &&
        original.width > 0 &&
        original.height > 0 &&
        copy instanceof HTMLCanvasElement
      ) {
        copy.getContext("2d")?.drawImage(original, 0, 0);
      }
    });
    const rearPositions = new Map<
      string,
      { transform: string; opacity: string }
    >();
    deck.querySelectorAll<HTMLElement>(".history-rear-card").forEach((rear) => {
      const style = getComputedStyle(rear);
      rearPositions.set(rear.dataset.historySnapshot!, {
        transform: style.transform,
        opacity: style.opacity,
      });
    });
    pending.current = {
      ghost,
      direction,
      sourceIdentity: identity,
      rearPositions,
    };
  }

  useLayoutEffect(() => {
    const transition = pending.current;
    const card = cardRef.current;
    if (!transition || !card) return;
    pending.current = null;
    const { ghost, direction, sourceIdentity, rearPositions } = transition;
    const older = direction === "older";
    const deck = card.parentElement!;
    card.dataset.historySwitched = "true";
    deck.dataset.historySwitched = "true";
    const priorInert = card.inert;
    const priorZIndex = card.style.zIndex;
    card.inert = true;
    card.style.zIndex = "2";
    const duration = older ? 360 : 420;
    const handoffDuration = 80;
    const easing = "cubic-bezier(.22,1,.36,1)";
    const rears = [...deck.querySelectorAll<HTMLElement>(".history-rear-card")];
    const destination = older
      ? undefined
      : rears.find((rear) => rear.dataset.historySnapshot === sourceIdentity);
    // Read final responsive stack positions, without sampling a CSS transition
    // partway through. Existing rear cards then move from their captured positions.
    const rearTransitions = rears.map((rear) => rear.style.transition);
    rears.forEach((rear) => {
      rear.style.transition = "none";
    });
    const positions = new Map(
      rears.map((rear) => {
        const style = getComputedStyle(rear);
        return [rear, { transform: style.transform, opacity: style.opacity }];
      }),
    );
    const destinationPosition = destination
      ? positions.get(destination)!
      : null;
    const previousVisibility = destination?.style.visibility ?? "";
    if (destination) destination.style.visibility = "hidden";
    const rearAnimations = rears
      .filter((rear) => rear !== destination)
      .map((rear) => {
        const target = positions.get(rear)!;
        const previous = rearPositions.get(rear.dataset.historySnapshot!);
        const matrix = new DOMMatrixReadOnly(target.transform);
        const depth =
          Number(rear.style.getPropertyValue("--history-depth")) || 1;
        // Going backward reveals an older card beyond the far end of the stack.
        // It must move forward from a deeper slot, like the retained rear cards.
        const enteringDepth = depth + (older ? 1 : -1);
        const from = previous ?? {
          transform: `translateY(${(matrix.f * enteringDepth) / depth}px) scale(${Math.min(1, matrix.a + (older ? -0.055 : 0.055))})`,
          opacity: older ? "0" : target.opacity,
        };
        return rear.animate([from, target], { duration, easing, fill: "both" });
      });
    // The front and background cards have different transform origins. Match
    // the destination's top-center origin so the final outlines coincide exactly.
    if (!older) ghost.style.transformOrigin = "top center";
    const outgoing = ghost.animate(
      [
        { transform: "translateY(0) scale(1)", opacity: 1 },
        {
          transform: older
            ? "translateY(84px) scale(1.025)"
            : (destinationPosition?.transform ??
              "translateY(-96px) scale(.835)"),
          opacity: destinationPosition
            ? Number(destinationPosition.opacity)
            : 0,
        },
      ],
      {
        duration: destination ? duration - handoffDuration : duration,
        easing,
        fill: "forwards",
      },
    );
    const incoming = card.animate(
      [
        {
          transform: older
            ? "translateY(-24px) scale(.96)"
            : "translateY(72px) scale(1.018)",
          opacity: older ? 0.45 : 0,
        },
        { transform: "translateY(0) scale(1)", opacity: 1 },
      ],
      { duration, easing, fill: "both" },
    );
    const animations = [outgoing, incoming, ...rearAnimations];
    const movingDone = Promise.allSettled(
      animations.map((animation) => animation.finished),
    );
    const outgoingDone = Promise.allSettled([outgoing.finished]);
    let finished = false;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduce = () => {
      if (media.matches) finish();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      animations.forEach((animation) => animation.cancel());
      ghost.remove();
      if (destination) destination.style.visibility = previousVisibility;
      rears.forEach((rear, index) => {
        rear.style.transition = rearTransitions[index];
      });
      card.inert = priorInert;
      card.style.zIndex = priorZIndex;
      media.removeEventListener("change", reduce);
      if (cleanup.current === finish) cleanup.current = null;
    };
    cleanup.current = finish;
    media.addEventListener("change", reduce);
    if (media.matches) finish();
    void (async () => {
      await outgoingDone;
      if (finished) return;
      if (destination && destinationPosition) {
        // Only hand off once the rendered outgoing card has reached its slot.
        // A short crossfade also changes its title into the compact history label.
        destination.style.visibility = previousVisibility;
        const reveal = destination.animate(
          [{ opacity: 0 }, { opacity: destinationPosition.opacity }],
          { duration: handoffDuration, fill: "both" },
        );
        const retire = ghost.animate(
          [{ opacity: destinationPosition.opacity }, { opacity: 0 }],
          { duration: handoffDuration, fill: "forwards" },
        );
        animations.push(reveal, retire);
        await Promise.allSettled([reveal.finished, retire.finished]);
      }
      await movingDone;
      finish();
    })();
  }, [identity, cardRef]);

  useLayoutEffect(
    () => () => {
      cleanup.current?.();
      pending.current?.ghost.remove();
      pending.current = null;
    },
    [],
  );

  return prepare;
}
