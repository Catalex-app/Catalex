import type { KeyboardEvent as ReactKeyboardEvent } from "react";

type KeyEvent = KeyboardEvent | ReactKeyboardEvent;
export function isComposingKey(event: KeyEvent) {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}
export function consumeKey(event: KeyEvent) {
  event.preventDefault();
  event.stopPropagation();
}
export function ownsKey(event: KeyEvent, scope: Element | null | undefined) {
  return Boolean(scope && event.target && scope.contains(event.target as Node));
}
export function hasActiveModal(event: KeyEvent) {
  // Expanded workspace panels still contain normal editor/preview key scopes.
  // Their own Escape handler runs after those scopes have handled the event.
  const selector =
    ':is([aria-modal="true"], [role="alertdialog"], dialog[open]):not([data-expanded-workspace-panel])';
  const target = event.target as Element | null;
  if (target?.closest?.(selector)) return true;
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).some(
    (element) =>
      element.getClientRects().length > 0 &&
      element.getAttribute("aria-hidden") !== "true",
  );
}
export function canHandleEscape(event: KeyEvent) {
  return (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !isComposingKey(event) &&
    !hasActiveModal(event)
  );
}
/** Leave native IME confirmation intact, but do not run application callbacks. */
export function guardInputKey<T extends HTMLElement>(
  event: ReactKeyboardEvent<T>,
  handler?: (event: ReactKeyboardEvent<T>) => void,
) {
  if (
    (event.key === "Enter" || event.key === "Escape") &&
    isComposingKey(event)
  ) {
    event.stopPropagation();
    return;
  }
  if (event.defaultPrevented) return;
  handler?.(event);
  if (
    event.defaultPrevented &&
    (event.key === "Enter" || event.key === "Escape")
  )
    event.stopPropagation();
}

/** Run before popup-library capture listeners; never cancel the native IME action. */
export function installImeKeyBoundary(target: Window = window) {
  const keydown = (event: KeyboardEvent) => {
    if (
      (event.key === "Enter" || event.key === "Escape") &&
      isComposingKey(event)
    ) {
      event.stopImmediatePropagation();
    }
  };
  target.addEventListener("keydown", keydown, true);
  return () => target.removeEventListener("keydown", keydown, true);
}
