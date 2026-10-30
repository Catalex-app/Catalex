import {
  type EditorView,
  type TooltipView,
  ViewPlugin,
  getTooltip,
  repositionTooltips,
  showTooltip,
} from "@codemirror/view";

// Match inline comment cards: content padding + line padding - card outset.
const TEXT_AREA_LEFT_INSET = 8 + 6 - 10;
const TEXT_AREA_RIGHT_INSET = 12 + 2;
const OBSTACLE_GAP = 8;
const MAX_POPUP_HEIGHT = 320;

export interface DiagnosticTooltipView extends TooltipView {
  positionReady: boolean;
  setAnchorVisible: (visible: boolean) => boolean;
}

/** Anchor gutter diagnostics beside their marker, inside the visible text area. */
export const diagnosticTooltipPosition = ViewPlugin.fromClass(
  class {
    private frame: number | null = null;

    constructor(private view: EditorView) {
      this.update();
    }

    update() {
      if (this.view.state.facet(showTooltip).some(Boolean)) {
        if (this.frame === null) this.trackPosition();
      } else if (this.frame !== null) {
        cancelAnimationFrame(this.frame);
        this.frame = null;
      }
    }

    // Track actual geometry while open, including drawer transforms and resizing
    // that do not produce CodeMirror updates. Stop all work when the popup closes.
    private trackPosition = () => {
      this.measure();
      this.frame = requestAnimationFrame(this.trackPosition);
    };

    destroy() {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
    }

    private measure() {
      if (!this.view.state.facet(showTooltip).some(Boolean)) {
        return;
      }
      this.view.requestMeasure({
        key: this,
        read: (view) => {
          const scroll = view.scrollDOM.getBoundingClientRect();
          const gutter = view.dom
            .querySelector(".cm-gutters")
            ?.getBoundingClientRect();
          const left =
            Math.max(scroll.left, gutter?.right ?? scroll.left) +
            TEXT_AREA_LEFT_INSET;
          const width = Math.max(
            0,
            Math.min(
              scroll.right - left - TEXT_AREA_RIGHT_INSET,
              window.innerWidth - left - TEXT_AREA_RIGHT_INSET,
            ),
          );
          const topEdge = Math.max(0, scroll.top) + OBSTACLE_GAP;
          let bottomEdge =
            Math.min(window.innerHeight, scroll.bottom) - OBSTACLE_GAP;
          for (const drawer of view.dom.ownerDocument.querySelectorAll<HTMLElement>(
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
            const drawerTop = Math.max(rect.top, clip?.top ?? rect.top);
            const drawerBottom = Math.min(
              rect.bottom,
              clip?.bottom ?? rect.bottom,
            );
            const drawerLeft = Math.max(rect.left, clip?.left ?? rect.left);
            const drawerRight = Math.min(rect.right, clip?.right ?? rect.right);
            if (
              drawerRight > left &&
              drawerLeft < left + width &&
              drawerBottom > topEdge &&
              drawerTop < bottomEdge &&
              drawerBottom > drawerTop &&
              drawerRight > drawerLeft
            )
              bottomEdge = Math.min(bottomEdge, drawerTop - OBSTACLE_GAP);
          }
          const maxHeight = Math.max(
            0,
            Math.min(MAX_POPUP_HEIGHT, bottomEdge - topEdge),
          );
          return view.state.facet(showTooltip).flatMap((spec) => {
            if (!spec) return [];
            const tooltip = getTooltip(
              view,
              spec,
            ) as DiagnosticTooltipView | null;
            if (
              !tooltip?.dom.classList.contains("cm-tooltip-lint") ||
              !tooltip.getCoords
            )
              return [];
            const marker = tooltip.getCoords(spec.pos);
            const height = Math.min(tooltip.dom.offsetHeight, maxHeight);
            // Follow the indicator until the popup reaches the drawer, then hold
            // at that boundary. Scrolling back releases it onto its original row.
            const top = Math.max(
              topEdge,
              Math.min(marker.top, bottomEdge - height),
            );
            return [
              {
                tooltip,
                width: `${width}px`,
                maxHeight: `${maxHeight}px`,
                visible:
                  marker.bottom > Math.max(0, scroll.top) &&
                  marker.top < Math.min(window.innerHeight, scroll.bottom) &&
                  marker.right > Math.max(0, scroll.left) &&
                  marker.left < Math.min(window.innerWidth, scroll.right),
                x: left - marker.left,
                y: top - marker.bottom,
              },
            ];
          });
        },
        write: (positions, view) => {
          let changed = false;
          for (const {
            tooltip,
            width,
            maxHeight,
            visible,
            x,
            y,
          } of positions) {
            const sameWidth =
              Math.abs(
                Number.parseFloat(tooltip.dom.style.width) -
                  Number.parseFloat(width),
              ) < 0.01;
            const sameHeight =
              Math.abs(
                Number.parseFloat(tooltip.dom.style.maxHeight) -
                  Number.parseFloat(maxHeight),
              ) < 0.01;
            const wasReady = tooltip.positionReady;
            // CSS serializes fractional lengths with rounding. Compare numerically
            // so the entrance can start once the final dimensions have settled.
            tooltip.positionReady = sameWidth && sameHeight;
            if (!wasReady && tooltip.positionReady) changed = true;
            if (tooltip.setAnchorVisible?.(visible)) changed = true;
            if (
              tooltip.offset?.x === x &&
              tooltip.offset?.y === y &&
              sameWidth &&
              sameHeight
            )
              continue;
            tooltip.offset = { x, y };
            tooltip.dom.style.width = width;
            tooltip.dom.style.maxWidth = "none";
            tooltip.dom.style.maxHeight = maxHeight;
            changed = true;
          }
          if (changed) repositionTooltips(view);
        },
      });
    }
  },
);
