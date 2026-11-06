import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

export const MIN_IMAGE_SCALE = 0.25;
export const MAX_IMAGE_SCALE = 4;

export type ImageFitMode = "fit-width" | "fit-height" | null;

export function useImageZoom({
  viewportRef,
  imageRef,
  sourceKey,
  scale,
  onScaleChange,
  base = "width",
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  imageRef: RefObject<HTMLImageElement | null>;
  sourceKey: string;
  scale: number;
  onScaleChange?: (scale: number) => void;
  base?: "width" | "contain";
}) {
  const [fit, setFit] = useState<{ key: string; mode: ImageFitMode } | null>(
    null,
  );
  const fitMode = fit?.key === sourceKey ? fit.mode : "fit-width";
  const [size, setSize] = useState({ width: 0, height: 0, ratio: 1 });

  useLayoutEffect(() => {
    setFit({ key: sourceKey, mode: "fit-width" });
    const viewport = viewportRef.current;
    const image = imageRef.current;
    if (!viewport || !image) return;
    const measure = () => {
      const style = getComputedStyle(viewport);
      const width = Math.max(
        0,
        viewport.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
      );
      const height = Math.max(
        0,
        viewport.clientHeight -
          parseFloat(style.paddingTop) -
          parseFloat(style.paddingBottom),
      );
      const ratio = image.naturalHeight
        ? image.naturalWidth / image.naturalHeight
        : 1;
      setSize((previous) =>
        previous.width === width &&
        previous.height === height &&
        previous.ratio === ratio
          ? previous
          : { width, height, ratio },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    image.addEventListener("load", measure);
    return () => {
      observer.disconnect();
      image.removeEventListener("load", measure);
    };
  }, [viewportRef, imageRef, sourceKey]);

  // Preserve the existing percentage zoom baseline for each image view.
  const baseWidth =
    base === "width"
      ? size.width
      : Math.min(size.width, size.height * size.ratio);
  const fittedWidth =
    fitMode === "fit-width" ? size.width : size.height * size.ratio;
  const displayScale =
    fitMode && baseWidth > 0 ? fittedWidth / baseWidth : scale;
  const width = baseWidth * displayScale;
  const changeScale = useCallback(
    (next: number) => {
      setFit({ key: sourceKey, mode: null });
      onScaleChange?.(
        Math.max(MIN_IMAGE_SCALE, Math.min(MAX_IMAGE_SCALE, next)),
      );
    },
    [onScaleChange, sourceKey],
  );
  const changeFitMode = useCallback(
    (mode: ImageFitMode) => {
      setFit({ key: sourceKey, mode });
    },
    [sourceKey],
  );

  return {
    fitMode,
    changeFitMode,
    displayScale,
    changeScale,
    width,
    height: width / size.ratio,
    viewportWidth: size.width,
    viewportHeight: size.height,
  };
}
