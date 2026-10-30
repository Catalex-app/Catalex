import { animateEditorPopup } from "./popup-animation";
import type { DiagnosticTooltipView } from "./diagnostic-tooltip-position";
import {
  createDiagnosticChatFooter,
  renderDiagnosticContent,
} from "./diagnostic-chat";
import {
  type Diagnostic,
  forEachDiagnostic,
  lintGutter,
} from "@codemirror/lint";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  EditorView,
  type Tooltip,
  ViewPlugin,
  getTooltip,
  hasHoverTooltips,
  closeHoverTooltips,
  showTooltip,
} from "@codemirror/view";

const HIDE_DELAY = 300;
// Lucide's vertical Pin outline, matching the app's icon set.
const PIN_MASK = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>')}")`;
const setTooltip = StateEffect.define<Tooltip | null>();
const tooltipState = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged || transaction.reconfigured) return null;
    for (const effect of transaction.effects) {
      if (effect.is(setTooltip)) return effect.value;
    }
    return value;
  },
  provide: (field) => showTooltip.from(field),
});

// Diagnostic details are available only through the gutter indicator. Close native
// text-hover results in the same transaction so they never render or flash.
const disableTextHoverTooltips = EditorState.transactionExtender.of(
  (transaction) =>
    hasHoverTooltips(transaction.state)
      ? { effects: closeHoverTooltips }
      : null,
);

function renderDiagnostics(view: EditorView, diagnostics: Diagnostic[]) {
  const list = document.createElement("ul");
  list.className = "cm-tooltip-lint";
  for (const diagnostic of diagnostics) {
    const item = document.createElement("li");
    item.className = `cm-diagnostic cm-diagnostic-${diagnostic.severity}`;
    item.append(renderDiagnosticContent(view, diagnostic));
    if (diagnostic === diagnostics[diagnostics.length - 1]) {
      item.append(createDiagnosticChatFooter(view, diagnostics));
    }
    list.append(item);
  }
  return list;
}

const tooltipInteraction = ViewPlugin.fromClass(
  class {
    private marker: HTMLElement | null = null;
    private pinned = false;
    private diagnostics: Diagnostic[] = [];
    private closing = false;
    private viewportHidden = false;
    private pendingEnter = false;
    private popup: HTMLElement | null = null;
    private animation: Animation | null = null;
    private hoverSuppressedMarker: HTMLElement | null = null;
    private hideTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private view: EditorView) {
      view.dom.addEventListener("mouseover", this.onHover);
      view.dom.addEventListener("mouseout", this.onLeaveMarker);
      view.dom.addEventListener("click", this.onClick);
      view.dom.addEventListener("keydown", this.onKeyDown);
      view.dom.ownerDocument.addEventListener(
        "pointermove",
        this.onPointerMove,
      );
      view.dom.ownerDocument.addEventListener(
        "pointerdown",
        this.onOutsidePointerDown,
        true,
      );
      view.dom.ownerDocument.addEventListener(
        "pointerleave",
        this.scheduleHide,
      );
      this.update();
    }

    update() {
      const spec = this.view.state.field(tooltipState);
      if (!spec) this.reset();
      else {
        const current: Diagnostic[] = [];
        forEachDiagnostic(this.view.state, (diagnostic, from) => {
          if (this.view.state.doc.lineAt(from).from === spec.pos)
            current.push(diagnostic);
        });
        // Keep the popup through viewport changes, but dismiss stale results.
        if (
          current.length !== this.diagnostics.length ||
          current.some(
            (diagnostic, index) => diagnostic !== this.diagnostics[index],
          )
        )
          queueMicrotask(() => {
            if (this.view.state.field(tooltipState) === spec) this.close();
          });
      }
      this.view.requestMeasure({
        key: this,
        read: () => {
          const markers = Array.from(
            this.view.dom.querySelectorAll<HTMLElement>(".cm-lint-marker"),
          );
          const spec = this.view.state.field(tooltipState);
          const replacement =
            spec && this.marker && !this.marker.isConnected
              ? markers.find(
                  (marker) =>
                    this.view.elementAtHeight(
                      marker.getBoundingClientRect().top +
                        5 -
                        this.view.documentTop,
                    ).from === spec.pos,
                )
              : null;
          return { markers, replacement };
        },
        write: ({ markers, replacement }) => {
          // Gutter DOM can be recreated while the same diagnostic stays visible.
          if (replacement && this.marker && !this.marker.isConnected) {
            if (this.marker.hasAttribute("data-pin-clicked"))
              replacement.setAttribute("data-pin-clicked", "true");
            this.marker = replacement;
          }
          for (const marker of markers) {
            marker.setAttribute("role", "button");
            marker.tabIndex = 0;
            marker.setAttribute("aria-label", "Show diagnostic details");
            marker.setAttribute(
              "aria-pressed",
              String(this.pinned && marker === this.marker),
            );
          }
        },
      });
    }

    private cancelHide = () => {
      if (this.hideTimer !== null) clearTimeout(this.hideTimer);
      this.hideTimer = null;
    };

    private scheduleHide = () => {
      if (
        this.pinned ||
        this.closing ||
        !this.marker ||
        this.hideTimer !== null
      )
        return;
      this.hideTimer = setTimeout(() => this.close(), HIDE_DELAY);
    };

    private contains(target: EventTarget | null) {
      if (!(target instanceof Node)) return false;
      const spec = this.view.state.field(tooltipState);
      return (
        this.marker?.contains(target) ||
        (spec && getTooltip(this.view, spec)?.dom.contains(target))
      );
    }

    private onPointerMove = (event: PointerEvent) => {
      if (this.contains(event.target)) this.cancelHide();
      else this.scheduleHide();
    };

    private onOutsidePointerDown = (event: PointerEvent) => {
      if (this.pinned || this.contains(event.target)) return;
      this.close();
    };

    private eventMarker(event: Event) {
      return event.target instanceof Element
        ? event.target.closest<HTMLElement>(".cm-lint-marker")
        : null;
    }

    private onHover = (event: MouseEvent) => {
      const marker = this.eventMarker(event);
      if (marker && !this.pinned && marker !== this.hoverSuppressedMarker)
        this.open(marker, false);
    };

    private onLeaveMarker = (event: MouseEvent) => {
      const marker = this.eventMarker(event);
      if (
        !marker ||
        (event.relatedTarget instanceof Node &&
          marker.contains(event.relatedTarget))
      )
        return;
      marker.removeAttribute("data-pin-clicked");
      if (marker === this.hoverSuppressedMarker) {
        marker.removeAttribute("data-hover-suppressed");
        this.hoverSuppressedMarker = null;
      }
    };

    private togglePin(marker: HTMLElement) {
      if (this.pinned && marker === this.marker) {
        // Closing must not immediately reopen under the stationary pointer.
        if (marker.matches(":hover")) {
          this.hoverSuppressedMarker = marker;
          marker.setAttribute("data-hover-suppressed", "true");
        }
        this.close();
      } else {
        this.hoverSuppressedMarker?.removeAttribute("data-hover-suppressed");
        this.hoverSuppressedMarker = null;
        this.open(marker, true);
        if (this.pinned && this.marker === marker)
          marker.setAttribute("data-pin-clicked", "true");
      }
    }

    private onClick = (event: MouseEvent) => {
      const marker = this.eventMarker(event);
      if (marker) this.togglePin(marker);
    };

    private onKeyDown = (event: KeyboardEvent) => {
      const marker = this.eventMarker(event);
      if (marker && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        this.togglePin(marker);
      }
    };

    private open(marker: HTMLElement, pinned: boolean) {
      this.cancelHide();
      if (marker === this.marker) {
        if (this.closing && this.popup) {
          this.closing = false;
          this.animatePopup(this.popup, true);
        }
        this.pinned ||= pinned;
        marker.setAttribute("aria-pressed", String(this.pinned));
        return;
      }
      const block = this.view.elementAtHeight(
        marker.getBoundingClientRect().top + 5 - this.view.documentTop,
      );
      const diagnostics: Diagnostic[] = [];
      forEachDiagnostic(this.view.state, (diagnostic, from) => {
        if (this.view.state.doc.lineAt(from).from === block.from)
          diagnostics.push(diagnostic);
      });
      if (!diagnostics.length) return;
      this.reset();
      this.marker = marker;
      this.diagnostics = diagnostics;
      this.pinned = pinned;
      marker.setAttribute("aria-pressed", String(pinned));
      const anchor = marker.getBoundingClientRect();
      const markerOffset = anchor.top - (block.top + this.view.documentTop);
      this.view.dispatch({
        effects: [
          setTooltip.of({
            pos: block.from,
            above: false,
            strictSide: true,
            clip: false,
            create: (view): DiagnosticTooltipView => {
              const dom = renderDiagnostics(view, diagnostics);
              this.popup = dom;
              dom.style.opacity = "0";
              dom.style.transform = "translateY(0)";
              let positioned = false;
              const tooltip: DiagnosticTooltipView = {
                dom,
                positionReady: false,
                // The position plugin limits height against the editor and drawer.
                resize: false,
                getCoords: () => {
                  if (this.marker?.isConnected)
                    return this.marker.getBoundingClientRect();
                  // CodeMirror virtualizes gutter markers outside its rendered range.
                  // Keep the pinned anchor tied to its document row until it returns.
                  const line = view.lineBlockAt(block.from);
                  return new DOMRect(
                    anchor.left,
                    view.documentTop + line.top + markerOffset,
                    anchor.width,
                    anchor.height,
                  );
                },
                setAnchorVisible: this.setAnchorVisible,
                positioned: () => {
                  // Resume only after the popup has been placed at its returned row.
                  if (
                    this.closing ||
                    this.viewportHidden ||
                    !tooltip.positionReady
                  )
                    return;
                  if (positioned && !this.pendingEnter) return;
                  positioned = true;
                  this.pendingEnter = false;
                  this.animatePopup(dom, true);
                },
              };
              return tooltip;
            },
          }),
        ],
      });
    }

    private setAnchorVisible = (visible: boolean) => {
      if (this.closing || visible === !this.viewportHidden) return false;
      this.viewportHidden = !visible;
      this.cancelHide();
      this.pendingEnter = false;
      if (!this.popup) return false;
      const dom = this.popup;
      if (!visible) {
        if (!this.pinned) this.close();
        else
          this.animatePopup(dom, false, () => {
            if (this.viewportHidden) dom.style.visibility = "hidden";
          });
      } else {
        if (dom.style.visibility === "hidden")
          dom.style.transform = "translateY(0)";
        dom.style.visibility = "";
        this.pendingEnter = true;
      }
      return true;
    };

    private animatePopup(
      dom: HTMLElement,
      opening: boolean,
      onFinish?: () => void,
    ) {
      this.animation = animateEditorPopup(dom, opening, this.animation, () => {
        this.animation = null;
        onFinish?.();
      });
    }

    private reset() {
      this.cancelHide();
      this.animation?.cancel();
      this.animation = null;
      this.popup = null;
      this.closing = false;
      this.viewportHidden = false;
      this.pendingEnter = false;
      this.marker?.setAttribute("aria-pressed", "false");
      this.marker?.removeAttribute("data-pin-clicked");
      this.marker = null;
      this.diagnostics = [];
      this.pinned = false;
    }

    private close() {
      if (this.closing) return;
      this.cancelHide();
      this.pinned = false;
      this.marker?.setAttribute("aria-pressed", "false");
      const finish = () => {
        this.reset();
        if (this.view.state.field(tooltipState)) {
          this.view.dispatch({ effects: setTooltip.of(null) });
        }
      };
      if (!this.popup || this.popup.style.visibility === "hidden")
        return finish();
      this.closing = true;
      this.animatePopup(this.popup, false, finish);
    }

    destroy() {
      this.reset();
      this.hoverSuppressedMarker?.removeAttribute("data-hover-suppressed");
      this.view.dom.removeEventListener("mouseover", this.onHover);
      this.view.dom.removeEventListener("mouseout", this.onLeaveMarker);
      this.view.dom.removeEventListener("click", this.onClick);
      this.view.dom.removeEventListener("keydown", this.onKeyDown);
      this.view.dom.ownerDocument.removeEventListener(
        "pointermove",
        this.onPointerMove,
      );
      this.view.dom.ownerDocument.removeEventListener(
        "pointerdown",
        this.onOutsidePointerDown,
        true,
      );
      this.view.dom.ownerDocument.removeEventListener(
        "pointerleave",
        this.scheduleHide,
      );
    }
  },
);

export const diagnosticGutter = [
  // Keep CodeMirror's diagnostic markers; manage their hover and pin lifecycle here.
  lintGutter({ tooltipFilter: () => [] }),
  tooltipState,
  disableTextHoverTooltips,
  tooltipInteraction,
  EditorView.baseTheme({
    ".cm-lint-marker": { cursor: "pointer", borderRadius: "3px" },
    '.cm-lint-marker:hover:not([data-hover-suppressed]), .cm-lint-marker[aria-pressed="true"]':
      {
        content: "none",
        position: "relative",
      },
    '.cm-lint-marker:hover:not([data-hover-suppressed])::before, .cm-lint-marker[aria-pressed="true"]::before':
      {
        content: '""',
        position: "absolute",
        inset: "0",
        backgroundColor: "currentColor",
        maskImage: PIN_MASK,
        maskSize: "contain",
        maskRepeat: "no-repeat",
        maskPosition: "center",
        transform: "rotate(0deg)",
        pointerEvents: "none",
      },
    '.cm-lint-marker[aria-pressed="true"]::before, .cm-lint-marker[aria-pressed="true"][data-pin-clicked]::before':
      {
        transform: "rotate(45deg)",
      },
    ".cm-lint-marker-error": { color: "var(--color-red-600)" },
    ".cm-lint-marker-warning": { color: "var(--color-amber-500)" },
    ".cm-lint-marker-info, .cm-lint-marker-hint": {
      color: "var(--color-blue-500)",
    },
    ".cm-lint-marker:focus-visible": {
      outline: "2px solid var(--ring)",
      outlineOffset: "3px",
    },
  }),
];
