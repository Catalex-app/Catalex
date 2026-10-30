// Deliberate diagnostic fixtures for exercising the shared editor UI.
export const minimapDemoName = "minimap-playground.tex";
const lines = Array.from(
  { length: 300 },
  (_, i) => `Paragraph ${i + 1}. Example text for navigating a long document.`,
);
lines[0] = String.raw`\documentclass{article}`;
lines[1] = String.raw`\begin{document}`;
lines[19] = "Separated Git change: this sentence was revised.";
lines[59] = "Separated human comment: clarify this result.";
lines[89] = "Separated agent comment: check this comparison.";
lines[119] = String.raw`Separated warning: see Section~\ref{missing-section}.`;
lines[159] = String.raw`Separated error: \undefinedDemoCommand`;
lines[219] = String.raw`Mixed group: revised result with \undefinedMixedCommand and a comment.`;
lines[220] = String.raw`Nearby warning: see Table~\ref{missing-table}.`;
lines[221] = "Nearby agent comment: verify this new conclusion.";
lines[299] = String.raw`\end{document}`;
export const minimapDemoSource = lines.join("\n");
export const minimapDemoBaseline = lines
  .map((line, index) =>
    index === 19
      ? "Separated Git change: original sentence."
      : index === 219
        ? "Mixed group: original result."
        : line,
  )
  .join("\n");
export const minimapDemoDiagnostics = [
  {
    severity: "warning",
    line: 120,
    message: "Demo: undefined section reference.",
  },
  {
    severity: "error",
    line: 160,
    message: "Demo: undefined control sequence.",
  },
  {
    severity: "error",
    line: 220,
    message: "Demo: error on the changed and commented line.",
  },
  {
    severity: "warning",
    line: 221,
    message: "Demo: warning beside the mixed group.",
  },
].map((item) => ({
  ...item,
  severity: item.severity as "error" | "warning",
  file: minimapDemoName,
}));
