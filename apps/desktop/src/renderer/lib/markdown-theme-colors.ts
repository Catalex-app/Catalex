export type MarkdownThemeColors = {
  background: string;
  text: string;
  accent: string;
};

// Keep the built-in palettes shared by preview and settings menus.
export const GITHUB_LIGHT_MARKDOWN_THEME_COLORS: MarkdownThemeColors = {
  background: "#ffffff",
  text: "#1f2328",
  accent: "#0969da",
};

export const GITHUB_DARK_MARKDOWN_THEME_COLORS: MarkdownThemeColors = {
  background: "#0d1117",
  text: "#e6edf3",
  accent: "#58a6ff",
};

export const GENERIC_MARKDOWN_THEME_COLORS: MarkdownThemeColors = {
  background: "#e5e7eb",
  text: "#64748b",
  accent: "#94a3b8",
};

/** Approximate palette only: inspect local declarations without applying the CSS
 * or loading its imports, images, or fonts. Unsupported values use neutral colors. */
export function markdownThemeColors(css: string): MarkdownThemeColors {
  const rules = [
    ...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ];
  const variables = new Map<string, string>();
  const declarations = rules.map(([, selector, body]) => {
    const values = new Map<string, string>();
    for (const [, property, value] of body.matchAll(
      /(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g,
    )) {
      const cleaned = value.replace(/\s*!important\s*$/i, "").trim();
      values.set(property, cleaned);
      if (property.startsWith("--") && !variables.has(property))
        variables.set(property, cleaned);
    }
    return { selector: selector.trim(), values };
  });
  const probe = document.createElement("span").style;
  const color = (input: string | undefined): string | undefined => {
    if (!input) return;
    let value = input;
    for (let depth = 0; depth < 5 && value.includes("var("); depth++) {
      value = value.replace(
        /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
        (_, name: string, fallback: string | undefined) =>
          variables.get(name) ?? fallback ?? "",
      );
    }
    // Context-dependent colors are not useful for an isolated swatch.
    if (
      /var\(|currentcolor|inherit|initial|unset|revert|transparent/i.test(value)
    )
      return;
    probe.color = "";
    probe.color = value;
    return probe.color || undefined;
  };
  const fromVariables = (names: string[]) =>
    names.map((name) => color(variables.get(name))).find(Boolean);
  const fromRules = (selector: RegExp, properties: string[]) => {
    for (const rule of declarations) {
      if (!selector.test(rule.selector)) continue;
      for (const property of properties) {
        const result = color(rule.values.get(property));
        if (result) return result;
      }
    }
  };
  const surface =
    /(?:^|,)\s*(?:body|html|:root|#write|\.markdown-body)\s*(?:,|$)/;
  return {
    background:
      fromVariables(["--bg-color", "--background-color", "--background"]) ??
      fromRules(surface, ["background-color", "background"]) ??
      GENERIC_MARKDOWN_THEME_COLORS.background,
    text:
      fromVariables(["--text-color", "--foreground-color", "--foreground"]) ??
      fromRules(surface, ["color"]) ??
      GENERIC_MARKDOWN_THEME_COLORS.text,
    accent:
      fromVariables([
        "--primary-color",
        "--link-color",
        "--accent-color",
        "--theme-color",
      ]) ??
      fromRules(/(?:^|[\s,>])a(?:$|[\s,:.[])/, ["color"]) ??
      fromRules(/(?:^|[\s,>])h[1-6](?:$|[\s,:.[])/, ["color"]) ??
      GENERIC_MARKDOWN_THEME_COLORS.accent,
  };
}
