import { hasActiveModal, isComposingKey } from "./keyboard-events";
/** Tooltips may prevent default, but must not steal Escape from open search. */
export function canCloseSearchOnEscape(event: KeyboardEvent) {
  const target = event.target as Element | null;
  if (
    target?.closest?.(
      '[role="menu"], [role="listbox"], [role="dialog"], [data-slot="popover-content"]',
    )
  )
    return false;
  return (
    event.key === "Escape" && !isComposingKey(event) && !hasActiveModal(event)
  );
}
