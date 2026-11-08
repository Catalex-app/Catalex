import { flushSync } from "react-dom";

const MOVE_EASING = "cubic-bezier(.3,.7,.3,1)";
const FADE_EASING = "cubic-bezier(.4,0,.6,1)";
const RETURN_DURATION = 490;
let activeTransition: ViewTransition | null = null;

type ProjectRow = {
  element: HTMLElement;
  rank: number;
  name: string;
};

function motionEnabled() {
  return (
    typeof document !== "undefined" &&
    !document.hidden &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function projectRows(projectRoot: string | null): ProjectRow[] {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="welcome-layout"] [data-project-path]',
    ),
  );
  const selected = elements.find(
    (element) => element.dataset.projectPath === projectRoot,
  );
  let following = 0;
  return elements.map((element, index) => ({
    element,
    rank: element === selected ? 0 : Math.min(++following, 4),
    name: `project-row-${index}`,
  }));
}

function animate(
  element: Element,
  frames: Keyframe[],
  duration: number,
  delay = 0,
  easing = MOVE_EASING,
  pseudoElement?: string,
) {
  const animation = element.animate(frames, {
    duration,
    delay,
    easing,
    fill: "both",
    ...(pseudoElement ? { pseudoElement } : {}),
  });
  animation.id = "project-navigation-row";
  return animation;
}

/** Show loading feedback without starting the handoff before the project is ready. */
export function beginProjectOpen(projectRoot: string): () => void {
  const welcome = document.querySelector<HTMLElement>(
    '[data-testid="welcome-layout"]',
  );
  if (!welcome) return () => {};
  const wasInert = welcome.inert;
  welcome.inert = true;
  welcome.setAttribute("aria-busy", "true");
  const selected = projectRows(projectRoot).find(
    (row) => row.rank === 0,
  )?.element;
  selected?.setAttribute("data-project-opening", "true");
  return () => {
    welcome.inert = wasInert;
    welcome.removeAttribute("aria-busy");
    selected?.removeAttribute("data-project-opening");
  };
}

/** Animate only the committed screen change, after project loading/saving succeeds. */
export async function updateProjectScreen(
  direction: "open" | "close",
  update: () => void,
  projectRoot: string | null,
): Promise<void> {
  if (activeTransition) {
    const previous = activeTransition;
    previous.skipTransition();
    // Finish its update and restore snapshot names before the next capture.
    await previous.finished.catch(() => {});
  }
  if (
    !motionEnabled() ||
    !document.startViewTransition ||
    !document.querySelector("[data-project-screen]")
  ) {
    update();
    return;
  }

  const root = document.documentElement;
  const restores: (() => void)[] = [];
  let rows: ProjectRow[] = [];
  const captureRows = () => {
    if (!CSS.supports("view-transition-class", "project-row")) return;
    rows = projectRows(projectRoot);
    for (const { element, name } of rows) {
      const previousName = element.style.viewTransitionName;
      const previousClass = element.style.getPropertyValue(
        "view-transition-class",
      );
      element.style.viewTransitionName = name;
      element.style.setProperty("view-transition-class", "project-row");
      restores.push(() => {
        element.style.viewTransitionName = previousName;
        if (previousClass)
          element.style.setProperty("view-transition-class", previousClass);
        else element.style.removeProperty("view-transition-class");
      });
    }
  };
  if (direction === "open") captureRows();
  root.dataset.projectNavigation = direction;
  let transition: ViewTransition;
  try {
    transition = document.startViewTransition(() => {
      // Capture a fully mounted workspace, including its proposal state.
      flushSync(update);
      if (direction === "close") captureRows();
    });
  } catch {
    restores.forEach((restore) => restore());
    delete root.dataset.projectNavigation;
    update();
    return;
  }
  activeTransition = transition;
  const rowAnimations: Animation[] = [];
  const clear = () => {
    rowAnimations.forEach((animation) => animation.cancel());
    restores.forEach((restore) => restore());
    if (activeTransition !== transition) return;
    activeTransition = null;
    delete root.dataset.projectNavigation;
  };
  void transition.ready
    .then(() => {
      for (const { name, rank } of rows) {
        const following = Math.max(0, rank - 1);
        const opening = direction === "open";
        const pseudo = `::view-transition-${opening ? "old" : "new"}(${name})`;
        const travel = rank === 0 ? 20 : rank === 1 ? 8 : 5;
        const returnDelay = rank === 0 ? 190 : 235 + following * 8;
        // Reveal the rows before most of their travel, keeping a 45 ms lead
        // for the closed project. Movement starts 20 ms after the fade.
        rowAnimations.push(
          animate(
            root,
            opening
              ? [
                  { transform: "none" },
                  { transform: `translateX(${travel}px)` },
                ]
              : [
                  { transform: `translateX(${travel}px)` },
                  { transform: "none" },
                ],
            opening
              ? rank === 0
                ? 190
                : 215 + following * 15
              : rank === 0
                ? 250
                : RETURN_DURATION - returnDelay - 20,
            opening ? (rank === 0 ? 0 : 12 + following * 10) : returnDelay + 20,
            MOVE_EASING,
            pseudo,
          ),
          animate(
            root,
            opening
              ? [{ opacity: 1 }, { opacity: 0 }]
              : [{ opacity: 0 }, { opacity: 1 }],
            opening ? 180 - rank * 15 : rank === 0 ? 100 : 110 + following * 8,
            opening ? rank * 15 : returnDelay,
            FADE_EASING,
            pseudo,
          ),
        );
      }
    })
    .catch(() => {});
  void transition.finished.then(clear, clear);
  // Navigation waits for its state update, never for the decorative animation.
  await transition.updateCallbackDone;
}
