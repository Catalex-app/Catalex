import { useEffect, useMemo, useRef, useState } from "react";
import { readMarkdownTheme } from "@/lib/markdown-theme";
import {
  GENERIC_MARKDOWN_THEME_COLORS,
  markdownThemeColors,
  type MarkdownThemeColors,
} from "@/lib/markdown-theme-colors";

// Reuse local file reads across both menu levels and subsequent openings.
const palettes = new Map<string, Promise<MarkdownThemeColors>>();
function loadPalette(path: string) {
  const cached = palettes.get(path);
  if (cached) return cached;
  const pending = readMarkdownTheme(path)
    .then(markdownThemeColors)
    .catch(() => GENERIC_MARKDOWN_THEME_COLORS);
  palettes.set(path, pending);
  if (palettes.size > 128) palettes.delete(palettes.keys().next().value!);
  return pending;
}

export function MarkdownThemeSwatch({
  path,
  css,
  palette,
}:
  | { path: string; css?: string; palette?: never }
  | { palette: MarkdownThemeColors; path?: never; css?: never }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [loaded, setLoaded] = useState<MarkdownThemeColors>(
    GENERIC_MARKDOWN_THEME_COLORS,
  );
  const colors = useMemo(
    () => palette ?? (css === undefined ? loaded : markdownThemeColors(css)),
    [palette, css, loaded],
  );
  useEffect(() => {
    if (!path || css !== undefined || !ref.current) return;
    let cancelled = false;
    setLoaded(GENERIC_MARKDOWN_THEME_COLORS);
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void loadPalette(path).then((palette) => {
        if (!cancelled) setLoaded(palette);
      });
    });
    observer.observe(ref.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [path, css]);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-testid="markdown-theme-swatch"
      className="inline-flex size-4 shrink-0 items-center gap-px"
    >
      {(["background", "text", "accent"] as const).map((role) => (
        <span
          key={role}
          data-theme-color={role}
          className="aspect-square min-w-0 flex-1 shadow-[inset_0_0_0_0.75px_rgb(0_0_0/0.38)] dark:shadow-[inset_0_0_0_0.75px_rgb(255_255_255/0.45)]"
          style={{ backgroundColor: colors[role] }}
        />
      ))}
    </span>
  );
}
