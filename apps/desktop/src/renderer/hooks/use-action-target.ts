import { useEffect, useRef, useState } from "react";

const surfaceEvent = "catalex:action-target";

/** Remember content focus across native menu blur, including iframe selections. */
export function useActionTarget(
  getElement: () => Element | null,
  identity: unknown,
  frameDocument?: Document,
  includeControls = false,
) {
  const element = useRef(getElement);
  element.current = getElement;
  const [active, setActive] = useState(false);
  useEffect(() => {
    const update = (target: Node | null) => {
      const surface = element.current();
      const control =
        target?.nodeType === 1
          ? (target as Element).closest("input, textarea, button")
          : null;
      // Events published by an iframe's content also target its enclosing panel.
      const frame = target?.ownerDocument?.defaultView?.frameElement;
      const inside =
        !!surface &&
        !!target &&
        (surface.contains(target) ||
          (!!frame && surface.contains(frame)) ||
          !!frameDocument?.body.contains(target));
      setActive(inside && (includeControls || !control));
    };
    const receive = (event: Event) =>
      update((event as CustomEvent<Node>).detail);
    const publish = (event: Event) =>
      window.dispatchEvent(
        new CustomEvent(surfaceEvent, { detail: event.target }),
      );
    const docs = new Set(
      [document, frameDocument].filter((doc): doc is Document => !!doc),
    );
    update(
      frameDocument &&
        document.activeElement === frameDocument.defaultView?.frameElement
        ? frameDocument.activeElement
        : document.activeElement,
    );
    window.addEventListener(surfaceEvent, receive);
    for (const doc of docs) {
      doc.addEventListener("pointerdown", publish, true);
      doc.addEventListener("focusin", publish);
    }
    return () => {
      window.removeEventListener(surfaceEvent, receive);
      for (const doc of docs) {
        doc.removeEventListener("pointerdown", publish, true);
        doc.removeEventListener("focusin", publish);
      }
    };
  }, [identity, frameDocument, includeControls]);
  return active;
}
