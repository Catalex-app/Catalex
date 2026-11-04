import { canHandleEscape, consumeKey, ownsKey } from "@/lib/keyboard-events";
import { Hint } from "@/components/ui/tooltip";
import { animateEditorPopup } from "./popup-animation";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface ToolbarAction {
  disabled?: boolean;
  busy?: boolean;
  description?: string;
  id: string;
  isAI: boolean;
  label: string;
  icon: ReactNode;
  hint?: string; // e.g. "Double-click also works"
}

interface SelectionToolbarProps {
  position: { top: number; left: number };
  getAnchor?: () => {
    top: number;
    left: number;
    bottomLimit?: number;
    expandLeft?: boolean;
    bounds?: { top: number; bottom: number; left: number; right: number };
  } | null;
  contextLabel: string;
  actions: ToolbarAction[];
  aiEnabled?: boolean;
  onAction: (actionId: string) => void;
  onDismiss: (reason?: "outside" | "escape") => void;
}

export function SelectionToolbar({
  position,
  contextLabel: _contextLabel,
  getAnchor,
  actions,
  aiEnabled = true,
  onAction,
  onDismiss,
}: SelectionToolbarProps) {
  const visibleActions = actions.filter((action) => aiEnabled || !action.isAI);
  const groupedActions = [
    ...visibleActions.filter((action) => action.isAI),
    ...visibleActions.filter((action) => !action.isAI),
  ];
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const expanded = !getAnchor || hovered || focused;

  const animationRef = useRef<Animation | null>(null);
  const visibleRef = useRef(false);
  const setVisible = useCallback((visible: boolean) => {
    const toolbar = toolbarRef.current;
    if (!toolbar || visibleRef.current === visible) return;
    visibleRef.current = visible;
    if (visible) toolbar.style.visibility = "visible";
    animationRef.current = animateEditorPopup(
      toolbar,
      visible,
      animationRef.current,
      () => {
        animationRef.current = null;
        if (!visibleRef.current) toolbar.style.visibility = "hidden";
      },
    );
  }, []);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    toolbar.style.opacity = "0";
    toolbar.style.visibility = "hidden";
    visibleRef.current = false;
    return () => {
      // React removes the toolbar immediately on selection dismissal. Retain an
      // inert visual copy just long enough to complete the same exit motion.
      const style = getComputedStyle(toolbar);
      const opacity = style.opacity;
      const rect = toolbar.getBoundingClientRect();
      const transform = style.transform;
      animationRef.current?.cancel();
      animationRef.current = null;
      if (style.visibility === "hidden" || Number(opacity) === 0) return;
      const exit = toolbar.cloneNode(true) as HTMLElement;
      exit.removeAttribute("data-selection-toolbar");
      exit.setAttribute("data-selection-toolbar-exit", "true");
      exit.setAttribute("aria-hidden", "true");
      Object.assign(exit.style, {
        position: "fixed",
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        opacity,
        transform,
        pointerEvents: "none",
      });
      exit.inert = true;
      document.body.append(exit);
      animateEditorPopup(exit, false, null, () => exit.remove());
    };
  }, []);

  // Measure while open so pane resizing and animated drawers cannot cover the
  // toolbar. Like diagnostics, hold it at the available bottom boundary.
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (toolbar && getAnchor) {
      let frame = 0;
      const trackCursor = () => {
        const anchor = getAnchor();

        if (anchor) {
          if (anchor.bounds) {
            const { top, bottom, left, right } = anchor.bounds;
            toolbar.style.maxHeight = `${Math.max(0, bottom - top)}px`;
            toolbar.style.top = `${Math.max(top, Math.min(anchor.top, bottom - toolbar.offsetHeight))}px`;
            if (anchor.expandLeft) {
              const fixedRight = Math.min(
                right,
                Math.max(left + 42, anchor.left + 42),
              );
              toolbar.style.left = "auto";
              toolbar.style.right = `${window.innerWidth - fixedRight}px`;
              toolbar.style.maxWidth = `${Math.max(0, fixedRight - left)}px`;
            } else {
              toolbar.style.maxWidth = `${Math.max(0, right - left)}px`;
              toolbar.style.left = `${Math.max(left, Math.min(anchor.left, right - toolbar.offsetWidth))}px`;
              toolbar.style.right = "auto";
            }
          } else {
            toolbar.style.top = `${anchor.bottomLimit === undefined ? anchor.top : Math.max(0, anchor.bottomLimit - toolbar.offsetHeight)}px`;
            toolbar.style.left = `${anchor.left}px`;
          }
        }
        setVisible(Boolean(anchor));
        frame = requestAnimationFrame(trackCursor);
      };
      trackCursor();
      return () => cancelAnimationFrame(frame);
    }
    const parent = toolbar?.offsetParent;
    if (!toolbar || !(parent instanceof HTMLElement)) return;
    let frame = 0;
    const measure = () => {
      const container = parent.getBoundingClientRect();
      const scroll = parent.querySelector(".cm-scroller");
      const bounds = scroll?.getBoundingClientRect() ?? container;
      const gutter = parent
        .querySelector(".cm-gutters")
        ?.getBoundingClientRect();
      const leftEdge =
        Math.max(0, bounds.left, gutter?.right ?? bounds.left) + 8;
      const rightEdge = Math.min(window.innerWidth, bounds.right) - 8;
      const topEdge = Math.max(0, bounds.top) + 8;
      let bottomEdge = Math.min(window.innerHeight, bounds.bottom) - 8;
      const width = Math.max(0, Math.min(256, rightEdge - leftEdge));
      const anchor = getAnchor
        ? getAnchor()
        : {
            top: container.top + position.top,
            left: container.left + position.left,
          };
      const left = Math.max(
        leftEdge,
        Math.min(anchor?.left ?? leftEdge, rightEdge - width),
      );
      for (const drawer of document.querySelectorAll<HTMLElement>(
        '[data-chat-drawer-panel="true"]',
      )) {
        if (drawer.closest('[data-drawer-presence="hidden"]')) continue;
        const style = getComputedStyle(drawer);
        if (style.visibility === "hidden" || Number(style.opacity) === 0)
          continue;
        const rect = drawer.getBoundingClientRect();
        const clip = drawer
          .closest('[data-chat-drawer-clip="true"]')
          ?.getBoundingClientRect();
        const top = Math.max(rect.top, clip?.top ?? rect.top);
        const bottom = Math.min(rect.bottom, clip?.bottom ?? rect.bottom);
        const drawerLeft = Math.max(rect.left, clip?.left ?? rect.left);
        const drawerRight = Math.min(rect.right, clip?.right ?? rect.right);
        if (
          drawerRight > left &&
          drawerLeft < left + width &&
          bottom > topEdge &&
          top < bottomEdge &&
          bottom > top &&
          drawerRight > drawerLeft
        ) {
          bottomEdge = Math.min(bottomEdge, top - 8);
        }
      }
      const maxHeight = Math.max(0, bottomEdge - topEdge);
      const set = (
        key: "width" | "maxHeight" | "top" | "left" | "visibility",
        value: string,
      ) => {
        if (toolbar.style[key] !== value) toolbar.style[key] = value;
      };
      set("width", `${width}px`);
      set("maxHeight", `${maxHeight}px`);
      const height = Math.min(toolbar.scrollHeight + 2, maxHeight);
      const top = Math.max(
        topEdge,
        Math.min(anchor?.top ?? topEdge, bottomEdge - height),
      );
      set("top", `${top - container.top + parent.scrollTop}px`);
      set("left", `${left - container.left + parent.scrollLeft}px`);
      setVisible(Boolean(anchor && width > 0 && maxHeight > 0));
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [getAnchor, position.top, position.left, setVisible]);

  // Dismiss on click outside or Escape
  useEffect(() => {
    const handleOutsideInteraction = (e: Event) => {
      if (
        (e instanceof MouseEvent &&
          (e.button === 2 || (e.ctrlKey && /Mac/.test(navigator.platform)))) ||
        (e.target as Element)?.closest?.('[data-slot="context-menu-content"]')
      )
        return;
      if (
        toolbarRef.current &&
        !toolbarRef.current.contains(e.target as Node)
      ) {
        onDismiss("outside");
      }
    };
    const owner = document.activeElement?.closest(
      ".cm-editor, [data-preview-pane]",
    );
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        canHandleEscape(e) &&
        (ownsKey(e, owner) || ownsKey(e, toolbarRef.current)) &&
        !(e.target as Element)?.closest?.('[data-slot="context-menu-content"]')
      ) {
        consumeKey(e);
        onDismiss("escape");
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleOutsideInteraction, true);
    // Delay only pointer dismissal to ignore the click that created the selection.
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleOutsideInteraction, true);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleOutsideInteraction, true);
      document.removeEventListener("focusin", handleOutsideInteraction, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismiss]);

  const toolbar = (
    <div
      ref={toolbarRef}
      data-selection-toolbar="true"
      data-ui-surface="popover"
      data-expanded={expanded}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false);
      }}
      className="popup-glass absolute z-50 w-64 overflow-y-auto overflow-x-hidden rounded-lg border border-[color:var(--popup-surface-border,var(--border))] bg-[var(--popup-surface-background,var(--background))] shadow-[0_0_0_transparent,var(--popup-surface-shadow,var(--shadow-xl))] transition-[width] duration-200 ease-[cubic-bezier(0.2,0,0.2,1)] motion-reduce:transition-none"
      style={{
        position: getAnchor ? "fixed" : "absolute",
        width: getAnchor ? (expanded ? 184 : 42) : undefined,
        visibility: getAnchor ? "hidden" : undefined,
        top: position.top,
        left: position.left,
      }}
    >
      {/* Action buttons */}
      {groupedActions.length > 0 && (
        <div className="flex flex-col py-1">
          {groupedActions.map((action, index) => (
            <Fragment key={action.id}>
              {index > 0 && groupedActions[index - 1].isAI !== action.isAI && (
                <div role="separator" className="mx-2 my-1 h-px bg-border" />
              )}
              <Hint content={action.description}>
                <button
                  aria-label={action.label}
                  aria-disabled={action.disabled || undefined}
                  aria-busy={action.busy || undefined}
                  aria-description={action.description}
                  onClick={() => {
                    if (!action.disabled) onAction(action.id);
                  }}
                  className={`flex items-center gap-2.5 whitespace-nowrap px-3 py-1.5 text-left text-foreground text-sm transition-colors ${action.disabled ? "cursor-default opacity-50" : "hover:bg-muted"}`}
                >
                  <span className="size-4 shrink-0 text-muted-foreground">
                    {action.icon}
                  </span>
                  <span
                    aria-hidden="true"
                    className="transition-opacity duration-200 motion-reduce:transition-none"
                    style={{ opacity: expanded ? 1 : 0 }}
                  >
                    {action.label}
                  </span>
                  {action.hint && expanded && (
                    <span className="ml-auto text-muted-foreground text-xs">
                      {action.hint}
                    </span>
                  )}
                </button>
              </Hint>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
  return getAnchor ? createPortal(toolbar, document.body) : toolbar;
}
