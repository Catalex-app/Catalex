import { type Diagnostic, forEachDiagnostic } from "@codemirror/lint";
import { Facet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface DiagnosticChatIssue {
  diagnostic: Diagnostic;
  from: number;
}
type FixDiagnostics = (view: EditorView, issues: DiagnosticChatIssue[]) => void;
const fixDiagnostics = Facet.define<
  FixDiagnostics | null,
  FixDiagnostics | null
>({
  combine: (values) => values[0] ?? null,
});

/** Content for each issue in the indicator popup. */
export function renderDiagnosticContent(
  view: EditorView,
  diagnostic: Diagnostic,
) {
  const content = document.createElement("div");
  const message = document.createElement("span");
  message.className = "cm-diagnosticText";
  message.append(diagnostic.renderMessage?.(view) ?? diagnostic.message);
  content.append(message);
  for (const action of diagnostic.actions ?? []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cm-diagnosticAction ${action.markClass ?? ""}`;
    button.textContent = action.name;
    button.onclick = () => {
      forEachDiagnostic(view.state, (current, from, to) => {
        if (current === diagnostic) action.apply(view, from, to);
      });
    };
    content.append(button);
  }
  if (diagnostic.source) {
    const source = document.createElement("div");
    source.className = "cm-diagnosticSource";
    source.textContent = diagnostic.source;
    content.append(source);
  }
  return content;
}

export function createDiagnosticChatFooter(
  view: EditorView,
  diagnostics: readonly Diagnostic[],
) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-diagnosticAction cm-diagnosticChatAction";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "12");
  icon.setAttribute("height", "12");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  // Match the MousePointerClick icon used by the Problems bar.
  for (const d of [
    "M14 4.1 12 6",
    "m5.1 8-2.9-.8",
    "m6 12-1.9 2",
    "M7.2 2.2 8 5.1",
    "M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z",
  ]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  const label = document.createElement("span");
  label.textContent =
    diagnostics.length > 1 ? "Fix them in chat" : "Fix this in chat";
  button.append(icon, label);
  button.onclick = () => {
    const positions = new Map<Diagnostic, number>();
    forEachDiagnostic(view.state, (diagnostic, from) =>
      positions.set(diagnostic, from),
    );
    const issues = diagnostics.flatMap((diagnostic) => {
      const from = positions.get(diagnostic);
      return from === undefined ? [] : [{ diagnostic, from }];
    });
    if (issues.length) view.state.facet(fixDiagnostics)?.(view, issues);
  };
  const footer = document.createElement("div");
  footer.className = "cm-diagnosticChatFooter";
  footer.append(button);
  return footer;
}

function createDiagnosticChatTheme(enabled: boolean) {
  return EditorView.theme({
    ".cm-tooltip-lint .cm-diagnosticChatFooter": {
      display: enabled ? "block" : "none",
      margin: "10px -12px 0",
      padding: "11px 12px 0",
      position: "relative",
    },
    ".cm-tooltip-lint .cm-diagnosticChatAction": {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      width: "fit-content",
      margin: "0",
      border: "0",
      lineHeight: "20px",
      padding: "4px 10px",
      backgroundColor: "#171717",
      color: "#ffffff",
    },
    ".cm-tooltip-lint .cm-diagnosticChatAction:hover": {
      backgroundColor: "#333333",
    },
    ".dark & .cm-tooltip-lint .cm-diagnosticChatAction": {
      backgroundColor: "#ffffff",
      color: "#171717",
    },
    ".dark & .cm-tooltip-lint .cm-diagnosticChatAction:hover": {
      backgroundColor: "#e5e5e5",
    },
  });
}
const diagnosticChatThemes = {
  enabled: createDiagnosticChatTheme(true),
  disabled: createDiagnosticChatTheme(false),
};

export function diagnosticChatMode(handler: FixDiagnostics | null) {
  return [
    fixDiagnostics.of(handler),
    handler ? diagnosticChatThemes.enabled : diagnosticChatThemes.disabled,
  ];
}
