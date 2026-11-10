import { OnboardingTitle } from "@/components/onboarding-title";
import { useEffect, useRef, useState } from "react";
import { useAppTheme } from "@/lib/app-theme";
import { useSettingsStore } from "@/stores/settings-store";
import {
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/settings-layout";
import {
  AppZoomControl,
  SettingsDropdown,
  SolarizeDropdown,
  EditorFontSizeDropdown,
  THEME_OPTIONS,
  EDITOR_COLOR_SCHEME_OPTIONS,
} from "@/components/settings/settings-window";
import { SidebarFiles } from "@/components/workspace/sidebar-files";
import { WorkspacePanel } from "@/components/workspace/workspace-panel";
import { HistorySnapshotContent } from "@/components/workspace/history-snapshot-content";
import "@/components/workspace/history-workspace.css";

const examples = {
  "paper.tex": String.raw`\documentclass{article}
\usepackage{amsmath, amssymb}

\title{A Small Step Toward a Better Proof}
\author{Your Name}

\begin{document}
\maketitle

\begin{abstract}
Every good paper starts with a clear idea.
Here, we explore a simple learning problem.
\end{abstract}

\section{The main idea}
Let $x \in \mathbb{R}^d$ be an input vector.
We minimize the empirical risk:
\begin{equation}
  \mathcal{L}(\theta) = \frac{1}{n}
  \sum_{i=1}^{n} \ell(f_\theta(x_i), y_i).
\end{equation}

% A little room for your next insight.
\section{Discussion}
What changes when the data are scarce?

\end{document}
`,
  "notes.md": `# Notes for our next paper

A small space for **big ideas**.

## Research question
How can we learn reliably from limited data?

- Start with a simple baseline
- Compare under the same conditions
- Make the results reproducible

## A useful equation
The objective is $L = \\frac{1}{n} \\sum_i \\ell_i$.

> A clear explanation is part of the result.

## Next steps
1. Write the first proof.
2. Check the assumptions.
3. Share a draft with collaborators.
`,
};
type ExampleFile = keyof typeof examples;

export function OnboardingAppearance() {
  const settings = useSettingsStore();
  const { theme, setTheme } = useAppTheme();
  const [activeFile, setActiveFile] = useState<ExampleFile>("paper.tex");
  const container = useRef<HTMLDivElement>(null);
  const [previewReady, setPreviewReady] = useState(false);

  useEffect(() => {
    const page = container.current?.closest(".onboarding-page-enter");
    const animations = page?.getAnimations() ?? [];
    let disposed = false;
    let paintFrame = 0;
    let readyFrame = 0;
    if (!animations.length) {
      // Reduced motion and standalone previews need no entrance delay.
      setPreviewReady(true);
    } else {
      void Promise.allSettled(
        animations.map((animation) => animation.finished),
      ).then(() => {
        if (disposed) return;
        // Present the final entrance frame before mounting CodeMirror.
        paintFrame = requestAnimationFrame(() => {
          readyFrame = requestAnimationFrame(() => {
            if (!disposed) setPreviewReady(true);
          });
        });
      });
    }
    return () => {
      disposed = true;
      cancelAnimationFrame(paintFrame);
      cancelAnimationFrame(readyFrame);
    };
  }, []);

  return (
    <div
      ref={container}
      className="grid items-start gap-10 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] lg:gap-16"
    >
      <div className="self-center">
        <h1
          id="onboarding-title"
          className="mb-8 font-semibold text-4xl tracking-tight"
        >
          <OnboardingTitle text="Get comfortable." />
        </h1>
        <div className="pb-3">
          <SettingsGroup title="General">
            <SettingsRow title="Appearance">
              <SettingsDropdown
                ariaLabel="Appearance"
                value={theme ?? "system"}
                options={THEME_OPTIONS}
                onChange={setTheme}
              />
            </SettingsRow>
            <SettingsRow title="App Zoom">
              <AppZoomControl />
            </SettingsRow>
            <SettingsRow id="onboarding-solarize" title="Solarize">
              <SolarizeDropdown
                value={settings.solarModeLevel}
                onValueChange={settings.setSolarModeLevel}
              />
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title="Editor">
            <SettingsRow title="Color scheme">
              <SettingsDropdown
                ariaLabel="Editor color scheme"
                value={settings.editorColorScheme}
                options={EDITOR_COLOR_SCHEME_OPTIONS}
                onChange={settings.setEditorColorScheme}
              />
            </SettingsRow>
            <SettingsRow id="onboarding-font-size" title="Font size">
              <EditorFontSizeDropdown
                value={settings.editorFontSize}
                onValueChange={settings.setEditorFontSize}
              />
            </SettingsRow>
          </SettingsGroup>
        </div>
      </div>
      <section
        aria-label="Workspace preview"
        className="flex h-[460px] min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-background pt-3 shadow-2xl lg:h-full lg:min-h-0 lg:w-full lg:max-w-[1036px] lg:justify-self-center"
      >
        <div className="history-card-body">
          <aside
            className="history-files history-shared-files"
            style={{ width: 140 }}
            aria-label="Example files"
          >
            <SidebarFiles
              className="bg-background text-sidebar-foreground"
              files={Object.keys(examples).map((path) => ({
                id: path,
                name: path,
                relativePath: path,
                type: path.endsWith(".tex")
                  ? ("tex" as const)
                  : ("other" as const),
              }))}
              activeFileId={activeFile}
              onSelectFile={(path) => setActiveFile(path as ExampleFile)}
              fileRowProps={(file) => ({
                "aria-pressed": activeFile === file.id,
              })}
            />
          </aside>
          <div
            className="history-content"
            data-testid="onboarding-preview-editor"
          >
            <WorkspacePanel className="h-full">
              <HistorySnapshotContent
                diff={null}
                content={examples[activeFile]}
                path={activeFile}
                loading={!previewReady}
                previewLabel={activeFile}
              />
            </WorkspacePanel>
          </div>
        </div>
      </section>
    </div>
  );
}
