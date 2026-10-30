export const FRONTEND_HEALTH_INTERVAL_MS = 60_000;

interface RectSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElementSnapshot {
  exists: boolean;
  tagName: string | null;
  id: string | null;
  className: string | null;
  childElementCount: number;
  textLength: number;
  rect: RectSnapshot | null;
  display: string | null;
  visibility: string | null;
  opacity: string | null;
  pointerEvents: string | null;
  position: string | null;
  zIndex: string | null;
  backgroundColor: string | null;
  transform: string | null;
  filter: string | null;
  backdropFilter: string | null;
  willChange: string | null;
  contain: string | null;
}

interface HitTestSnapshot extends ElementSnapshot {
  role: string | null;
  ariaLabel: string | null;
}

interface PointTraceSnapshot {
  x: number;
  y: number;
  stack: HitTestSnapshot[];
}

interface ChatLayerStateSnapshot {
  assistantMode: string | null;
  drawerPresence: string | null;
  modeTransitionPhase: string | null;
  composerTransferPhase: string | null;
}

interface ChatLayerSnapshot {
  state: ChatLayerStateSnapshot;
  overlay: ElementSnapshot;
  transitionShell: ElementSnapshot;
  clip: ElementSnapshot;
  drawerPanel: ElementSnapshot;
  composerShell: ElementSnapshot;
}

export interface FrontendHealthSnapshot {
  timestamp: number;
  uptimeMs: number;
  location: {
    pathname: string;
    search: string;
  };
  document: {
    visibilityState: DocumentVisibilityState;
    hidden: boolean;
    hasFocus: boolean;
    readyState: DocumentReadyState;
  };
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  root: ElementSnapshot;
  body: ElementSnapshot;
  loadingScreen: ElementSnapshot;
  activeElement: HitTestSnapshot | null;
  centerElement: HitTestSnapshot | null;
  hitTest: {
    centerStack: HitTestSnapshot[];
    composerStack: HitTestSnapshot[];
  };
  chat: ChatLayerSnapshot;
}

function rectSnapshot(element: Element): RectSnapshot {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function computedStyleSnapshot(
  win: Window,
  element: Element,
): Pick<
  ElementSnapshot,
  | "display"
  | "visibility"
  | "opacity"
  | "pointerEvents"
  | "position"
  | "zIndex"
  | "backgroundColor"
  | "transform"
  | "filter"
  | "backdropFilter"
  | "willChange"
  | "contain"
> {
  const style = win.getComputedStyle(element);
  return {
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    pointerEvents: style.pointerEvents,
    position: style.position,
    zIndex: style.zIndex,
    backgroundColor: style.backgroundColor,
    transform: style.transform,
    filter: style.filter,
    backdropFilter: style.backdropFilter,
    willChange: style.willChange,
    contain: style.contain,
  };
}

function elementSnapshot(
  element: Element | null,
  win: Window,
): ElementSnapshot {
  if (!element) {
    return {
      exists: false,
      tagName: null,
      id: null,
      className: null,
      childElementCount: 0,
      textLength: 0,
      rect: null,
      display: null,
      visibility: null,
      opacity: null,
      pointerEvents: null,
      position: null,
      zIndex: null,
      backgroundColor: null,
      transform: null,
      filter: null,
      backdropFilter: null,
      willChange: null,
      contain: null,
    };
  }

  return {
    exists: true,
    tagName: element.tagName.toLowerCase(),
    id: element.id || null,
    className:
      typeof element.className === "string" && element.className
        ? element.className
        : null,
    childElementCount: element.childElementCount,
    textLength: element.textContent?.length ?? 0,
    rect: rectSnapshot(element),
    ...computedStyleSnapshot(win, element),
  };
}

function querySnapshot(
  doc: Document,
  win: Window,
  selector: string,
): ElementSnapshot {
  return elementSnapshot(doc.querySelector(selector), win);
}

function hitTestSnapshot(
  element: Element | null,
  win: Window,
): HitTestSnapshot | null {
  if (!element) return null;
  return {
    ...elementSnapshot(element, win),
    role: element.getAttribute("role"),
    ariaLabel: element.getAttribute("aria-label"),
  };
}

function pointTraceSnapshot(
  doc: Document,
  win: Window,
  x: number,
  y: number,
): PointTraceSnapshot {
  const stack =
    typeof doc.elementsFromPoint === "function"
      ? doc.elementsFromPoint(x, y)
      : typeof doc.elementFromPoint === "function"
        ? [doc.elementFromPoint(x, y)].filter(
            (element): element is Element => element !== null,
          )
        : [];

  return {
    x,
    y,
    stack: stack
      .slice(0, 8)
      .map((element) => hitTestSnapshot(element, win))
      .filter((entry): entry is HitTestSnapshot => entry !== null),
  };
}

function chatLayerSnapshot(doc: Document, win: Window): ChatLayerSnapshot {
  const overlay = doc.querySelector("[data-chat-drawer-overlay='true']");

  return {
    state: {
      assistantMode: overlay?.getAttribute("data-assistant-mode") ?? null,
      drawerPresence: overlay?.getAttribute("data-drawer-presence") ?? null,
      modeTransitionPhase:
        overlay?.getAttribute("data-mode-transition-phase") ?? null,
      composerTransferPhase:
        overlay?.getAttribute("data-composer-transfer-phase") ?? null,
    },
    overlay: elementSnapshot(overlay, win),
    transitionShell: querySnapshot(
      doc,
      win,
      "[data-chat-drawer-transition-shell='true']",
    ),
    clip: querySnapshot(doc, win, "[data-chat-drawer-clip='true']"),
    drawerPanel: querySnapshot(doc, win, "[data-chat-drawer-panel='true']"),
    composerShell: querySnapshot(doc, win, "[data-chat-composer-shell='true']"),
  };
}

export function collectFrontendHealthSnapshot(
  doc: Document = document,
  win: Window = window,
  timestamp = Date.now(),
): FrontendHealthSnapshot {
  const root = doc.getElementById("root");
  const body = doc.body;
  const loadingScreen = doc.getElementById("loading-screen");
  const centerX = Math.max(0, Math.floor(win.innerWidth / 2));
  const centerY = Math.max(0, Math.floor(win.innerHeight / 2));
  const composerY = Math.max(0, win.innerHeight - 80);
  const centerElement =
    typeof doc.elementFromPoint === "function"
      ? doc.elementFromPoint(centerX, centerY)
      : null;
  const centerTrace = pointTraceSnapshot(doc, win, centerX, centerY);
  const composerTrace = pointTraceSnapshot(doc, win, centerX, composerY);

  return {
    timestamp,
    uptimeMs: Math.round(win.performance.now()),
    location: {
      pathname: win.location.pathname,
      search: win.location.search,
    },
    document: {
      visibilityState: doc.visibilityState,
      hidden: doc.hidden,
      hasFocus: doc.hasFocus(),
      readyState: doc.readyState,
    },
    viewport: {
      width: win.innerWidth,
      height: win.innerHeight,
      devicePixelRatio: win.devicePixelRatio,
    },
    root: elementSnapshot(root, win),
    body: elementSnapshot(body, win),
    loadingScreen: elementSnapshot(loadingScreen, win),
    activeElement: hitTestSnapshot(doc.activeElement, win),
    centerElement: hitTestSnapshot(centerElement, win),
    hitTest: {
      centerStack: centerTrace.stack,
      composerStack: composerTrace.stack,
    },
    chat: chatLayerSnapshot(doc, win),
  };
}
