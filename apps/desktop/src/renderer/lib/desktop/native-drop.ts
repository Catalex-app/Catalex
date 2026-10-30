export type NativeDropPosition = { x: number; y: number };

type ElementFromPoint = (x: number, y: number) => Element | null;

export function getElementFromNativeDropPosition(
  position: NativeDropPosition | undefined,
  options: {
    root?: Element | null;
    pixelRatio?: number;
    elementFromPoint?: ElementFromPoint;
  } = {},
) {
  if (!position) return null;

  const root = options.root ?? null;
  const pixelRatio = options.pixelRatio ?? window.devicePixelRatio;
  const elementFromPoint =
    options.elementFromPoint ?? document.elementFromPoint.bind(document);

  const rawEl = elementFromPoint(position.x, position.y);
  if (!root || (rawEl && root.contains(rawEl))) return rawEl;

  if (pixelRatio !== 1) {
    const scaledEl = elementFromPoint(
      position.x / pixelRatio,
      position.y / pixelRatio,
    );
    if (!root || (scaledEl && root.contains(scaledEl))) return scaledEl;
  }

  return rawEl;
}

export function isNativeDropPointInsideElement(
  position: NativeDropPosition | undefined,
  root: Element | null,
  options: {
    pixelRatio?: number;
    elementFromPoint?: ElementFromPoint;
  } = {},
) {
  if (!root) return false;
  const el = getElementFromNativeDropPosition(position, {
    ...options,
    root,
  });
  return Boolean(el && root.contains(el));
}
