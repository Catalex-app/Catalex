import { beforeEach, describe, expect, it } from "vitest";
import {
  INITIAL_CLAUDE_MODEL,
  INITIAL_CODEX_MODEL,
  migrateSettingsState,
  normalizeCatCustomText,
  useSettingsStore,
} from "./settings-store";
import { DEFAULT_AGENT_MD } from "@/lib/default-agent-md";
import {
  DEFAULT_PROMPT_LIBRARY,
  visiblePromptLibrary,
} from "@/lib/prompt-library";
import { DEFAULT_MODE_THEMES } from "@/lib/ui-theme";
import {
  GITHUB_DARK_MARKDOWN_THEME_ID,
  GITHUB_LIGHT_MARKDOWN_THEME_ID,
} from "@/lib/markdown-theme";

beforeEach(() => {
  useSettingsStore.setState({
    skippedUpdateVersions: [],
    modeThemes: { ...DEFAULT_MODE_THEMES },
    displayComments: true,
    showPdfComments: true,
    defaultAutoCompile: true,
    autoCompileByProject: {},
    scrollSyncByProject: {},
    compilerBackend: "latexmk",
    compilerEngine: "xelatex",
    compilerChoicesByRoot: {},
    markdownLoadTyporaThemes: true,
    defaultMarkdownMathEngine: "katex",
    markdownMathEnginesByFile: {},
    recentMarkdownThemePaths: [],
    recentMarkdownThemeOrder: [],
    markdownThemeDirectory: null,
    markdownSeparateLightDarkThemes: true,
    markdownPreviewTheme: GITHUB_LIGHT_MARKDOWN_THEME_ID,
    markdownPreviewLightTheme: GITHUB_LIGHT_MARKDOWN_THEME_ID,
    markdownPreviewDarkTheme: GITHUB_DARK_MARKDOWN_THEME_ID,
    keyboardShortcutOverrides: {},
  });
});

describe("project workspace preferences", () => {
  it("defaults to Duet drawer and restores each project's mode and layout", async () => {
    useSettingsStore.setState({ workspacePreferencesByProject: {} });
    const store = useSettingsStore.getState;
    expect(store().getWorkspacePreferences("/new")).toEqual({
      mode: "duet",
      chatLayout: "drawer",
    });
    store().setWorkspacePreferences("/one", {
      mode: "artisan",
      chatLayout: "workspace",
    });
    store().setWorkspacePreferences("/two", {
      mode: "duet",
      chatLayout: "workspace",
    });
    const saved = localStorage.getItem("catalex-settings")!;
    useSettingsStore.setState({ workspacePreferencesByProject: {} });
    localStorage.setItem("catalex-settings", saved);
    await useSettingsStore.persist.rehydrate();
    expect(store().getWorkspacePreferences("/one")).toEqual({
      mode: "artisan",
      chatLayout: "workspace",
    });
    expect(store().getWorkspacePreferences("/two")).toEqual({
      mode: "duet",
      chatLayout: "workspace",
    });
  });

  it("rehydrates version 22 without resetting unrelated settings", async () => {
    localStorage.setItem(
      "catalex-settings",
      JSON.stringify({
        version: 22,
        state: {
          workspaceModesByProject: { "/project": "handoff" },
          modeThemes: { pure: "modern", sidecar: "classic", handoff: "modern" },
          defaultDuetExecutionMode: "edit",
          defaultVibeExecutionMode: "default",
          enabledProviders: { claude: false, codex: true },
          showAnswerCompletionTime: true,
          latexInstallation: "/custom/tex",
        },
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState()).toMatchObject({
      workspacePreferencesByProject: {
        "/project": { mode: "duet", chatLayout: "workspace" },
      },
      modeThemes: { artisan: "modern", duet: "classic" },
      defaultAgentExecutionMode: "edit",
      enabledProviders: { claude: false, codex: true },
      showAnswerCompletionTime: true,
      latexInstallation: "/custom/tex",
    });
    const saved = JSON.parse(localStorage.getItem("catalex-settings")!).state;
    expect(saved).not.toHaveProperty("workspaceModesByProject");
    expect(saved).not.toHaveProperty("defaultDuetExecutionMode");
    expect(saved).not.toHaveProperty("defaultVibeExecutionMode");
  });

  it("migrates all legacy modes and ignores invalid preferences", () => {
    expect(
      migrateSettingsState({
        workspaceModesByProject: {
          "/artisan": "pure",
          "/drawer": "sidecar",
          "/workspace": "handoff",
          "/bad": "invalid",
        },
      }).workspacePreferencesByProject,
    ).toEqual({
      "/artisan": { mode: "artisan", chatLayout: "drawer" },
      "/drawer": { mode: "duet", chatLayout: "drawer" },
      "/workspace": { mode: "duet", chatLayout: "workspace" },
    });
    expect(
      migrateSettingsState({
        workspacePreferencesByProject: {
          "/valid": { mode: "duet", chatLayout: "invalid" },
          "/bad": { mode: "vibe" },
        },
      }).workspacePreferencesByProject,
    ).toEqual({ "/valid": { mode: "duet", chatLayout: "drawer" } });
  });

  it("migrates the Duet permission default and honors the new setting", () => {
    expect(
      migrateSettingsState({
        defaultDuetExecutionMode: "edit",
        defaultVibeExecutionMode: "default",
      }).defaultAgentExecutionMode,
    ).toBe("edit");
    expect(
      migrateSettingsState({
        defaultAgentExecutionMode: "default",
        defaultDuetExecutionMode: "edit",
      }).defaultAgentExecutionMode,
    ).toBe("default");
  });
});

describe("file scroll-sync preferences", () => {
  it("persists enabled and disabled choices independently by project and file", async () => {
    const store = useSettingsStore.getState;
    store().setFileScrollSync("/one", "main.tex", false);
    store().setFileScrollSync("/one", "README.md", true);
    store().setFileScrollSync("/two", "main.tex", true);
    const saved = localStorage.getItem("catalex-settings")!;
    useSettingsStore.setState({ scrollSyncByProject: {} });
    localStorage.setItem("catalex-settings", saved);
    await useSettingsStore.persist.rehydrate();
    expect(store().scrollSyncByProject).toEqual({
      "/one": { "main.tex": false, "README.md": true },
      "/two": { "main.tex": true },
    });
    expect(store().scrollSyncByProject["/one"]["new.tex"]).toBeUndefined();
  });

  it("accepts old settings without preferences and drops malformed choices", async () => {
    expect(migrateSettingsState({}).scrollSyncByProject).toEqual({});
    const preferences = {
      "/one": { "main.tex": false, "README.md": true, "bad.tex": "false" },
      "/invalid": [true],
    };
    expect(
      migrateSettingsState({ scrollSyncByProject: preferences })
        .scrollSyncByProject,
    ).toEqual({
      "/one": { "main.tex": false, "README.md": true },
      "/invalid": {},
    });
    localStorage.setItem(
      "catalex-settings",
      JSON.stringify({
        version: 24,
        state: { scrollSyncByProject: preferences },
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().scrollSyncByProject["/one"]).toEqual({
      "main.tex": false,
      "README.md": true,
    });
  });
});

describe("workspace theme assignments", () => {
  it("keeps the existing appearance as the default for each mode", () => {
    expect(useSettingsStore.getState().modeThemes).toEqual({
      artisan: "classic",
      duet: "modern",
    });
    expect(migrateSettingsState({}).modeThemes).toEqual(DEFAULT_MODE_THEMES);
  });

  it("changes one mode independently and restores assignments from storage", async () => {
    useSettingsStore.getState().setModeTheme("artisan", "modern");
    useSettingsStore.getState().setModeTheme("duet", "classic");
    const expected = { artisan: "modern", duet: "classic" };
    expect(useSettingsStore.getState().modeThemes).toEqual(expected);

    const saved = localStorage.getItem("catalex-settings");
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved as string).state.modeThemes).toEqual(expected);
    useSettingsStore.setState({ modeThemes: { ...DEFAULT_MODE_THEMES } });
    localStorage.setItem("catalex-settings", saved as string);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().modeThemes).toEqual(expected);
  });

  it("adds defaults when loading settings saved before theme assignments", async () => {
    localStorage.setItem(
      "catalex-settings",
      JSON.stringify({
        version: 20,
        state: {
          editorFontSize: 18,
          displayComments: false,
          showPdfComments: false,
        },
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().modeThemes).toEqual(DEFAULT_MODE_THEMES);
    expect(useSettingsStore.getState().editorFontSize).toBe(18);
    expect(useSettingsStore.getState().displayComments).toBe(false);
    expect(useSettingsStore.getState().showPdfComments).toBe(false);
  });

  it("normalizes incomplete or invalid assignments even at the current storage version", async () => {
    localStorage.setItem(
      "catalex-settings",
      JSON.stringify({
        version: useSettingsStore.persist.getOptions().version,
        state: {
          modeThemes: { pure: "modern", sidecar: "unknown", extra: "classic" },
        },
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().modeThemes).toEqual({
      artisan: "modern",
      duet: "modern",
    });
  });

  it.each([
    null,
    [],
    "classic",
    42,
  ])("uses defaults for malformed assignments: %j", (modeThemes) => {
    expect(migrateSettingsState({ modeThemes }).modeThemes).toEqual(
      DEFAULT_MODE_THEMES,
    );
  });
});

describe("settings-store cat display settings", () => {
  it("starts new installs with provider-managed model defaults", () => {
    expect(migrateSettingsState({})).toMatchObject({
      defaultAgent: "codex",
      defaultClaudeModel: INITIAL_CLAUDE_MODEL,
      defaultClaudeEffortLevel: "medium",
      defaultCodexModel: INITIAL_CODEX_MODEL,
      defaultCodexReasoningEffort: "medium",
    });
    expect(INITIAL_CLAUDE_MODEL).toBe("default");
    expect(INITIAL_CODEX_MODEL).toBe("default");
  });

  it("defaults to static Bibilabu display", () => {
    useSettingsStore.setState({
      catDisplayMode: "static",
      catStaticDisplay: "bibilabu",
      catCustomText: "",
      catSelectedCcfddlDeadline: null,
      catDisplayTimezone: "local",
      catCountdownPrecision: "dhm",
    });

    expect(useSettingsStore.getState().catDisplayMode).toBe("static");
    expect(useSettingsStore.getState().catStaticDisplay).toBe("bibilabu");
    expect(useSettingsStore.getState().catCountdownPrecision).toBe("dhm");
  });

  it("normalizes custom cat text", () => {
    expect(normalizeCatCustomText("  hello cat  ")).toBe("hello cat");
    expect(normalizeCatCustomText("x".repeat(40))).toHaveLength(28);
  });

  it("migrates old settings while adding CCFDDL defaults", () => {
    const migrated = migrateSettingsState({
      compilerBackend: "tectonic",
      compilerEngine: "lualatex",
      defaultAgent: "claude",
      defaultClaudeModel: "opus",
      defaultClaudeEffortLevel: "medium",
      defaultCodexModel: "gpt-5.4",
      defaultCodexReasoningEffort: "medium",
      defaultAgentExecutionMode: "default",
      editorColorScheme: "forest",
      editorFontSize: 18,
      solarModeLevel: 3,
    });

    expect(migrated).toMatchObject({
      compilerBackend: "tectonic",
      compilerEngine: "lualatex",
      defaultAgent: "claude",
      globalAgentPrompt: DEFAULT_AGENT_MD,
      editorColorScheme: "forest",
      editorFontSize: 18,
      solarModeLevel: 3,
      catDisplayMode: "ccfddl",
      catStaticDisplay: "bibilabu",
      catCustomText: "",
      catSelectedCcfddlDeadline: null,
      catDisplayTimezone: "local",
      catCountdownPrecision: "dhm",
    });
  });

  it("preserves valid CCFDDL selections during migration", () => {
    const migrated = migrateSettingsState({
      catDisplayMode: "ccfddl",
      catStaticDisplay: "custom",
      catCustomText: "Deadline mode",
      catDisplayTimezone: "source",
      catCountdownPrecision: "dh",
      catSelectedCcfddlDeadline: {
        id: "sigmod-2027",
        title: "SIGMOD 2027",
        displayTitle: "SIGMOD 2027 (first round)",
        deadline: "2026-07-02 17:00:00",
        deadlineIso: "2026-07-03T01:00:00.000Z",
        sourceTimezone: "UTC-8",
      },
    });

    expect(migrated.catDisplayMode).toBe("ccfddl");
    expect(migrated.catStaticDisplay).toBe("custom");
    expect(migrated.catDisplayTimezone).toBe("source");
    expect(migrated.catCountdownPrecision).toBe("dh");
    expect(migrated.catSelectedCcfddlDeadline?.id).toBe("sigmod-2027");
  });

  it("migrates valid agent preference defaults and removes legacy plan mode", () => {
    const migrated = migrateSettingsState({
      defaultAgent: "claude",
      defaultClaudeModel: "sonnet",
      defaultClaudeEffortLevel: "high",
      defaultCodexModel: "gpt-5.5",
      defaultCodexReasoningEffort: "xhigh",
      defaultDuetExecutionMode: "plan",
      defaultVibeExecutionMode: "plan",
      globalAgentPrompt: "Use ~/cite for citations.",
      useGlobalAgentPrompt: false,
    });

    expect(migrated).toMatchObject({
      defaultAgent: "claude",
      defaultClaudeModel: "sonnet",
      defaultClaudeEffortLevel: "high",
      defaultCodexModel: "gpt-5.5",
      defaultCodexReasoningEffort: "xhigh",
      defaultAgentExecutionMode: "default",
      globalAgentPrompt: "Use ~/cite for citations.",
    });
    expect(migrated).not.toHaveProperty("useGlobalAgentPrompt");
  });

  it("normalizes invalid defaults while preserving dynamic provider values", () => {
    const migrated = migrateSettingsState({
      defaultAgent: "other",
      defaultClaudeModel: "claude-fable-5[1m]",
      defaultClaudeEffortLevel: "xhigh",
      defaultCodexModel: "gpt-4",
      defaultCodexReasoningEffort: "max",
      defaultDuetExecutionMode: "write",
      defaultVibeExecutionMode: "ask",
      globalAgentPrompt: 42,
      useGlobalAgentPrompt: "yes",
    });

    expect(migrated).toMatchObject({
      defaultAgent: "codex",
      defaultClaudeModel: "claude-fable-5[1m]",
      defaultClaudeEffortLevel: "xhigh",
      defaultCodexModel: "gpt-4",
      defaultCodexReasoningEffort: "max",
      defaultAgentExecutionMode: "default",
      globalAgentPrompt: DEFAULT_AGENT_MD,
    });
  });

  it("updates and resets the global agent prompt", () => {
    useSettingsStore.getState().setGlobalAgentPrompt("Use ~/cite.");
    expect(useSettingsStore.getState().globalAgentPrompt).toBe("Use ~/cite.");

    useSettingsStore.getState().resetGlobalAgentPrompt();
    expect(useSettingsStore.getState().globalAgentPrompt).toBe(
      DEFAULT_AGENT_MD,
    );
  });

  it("migrates, updates, unassigns, and resets keyboard shortcuts", () => {
    expect(
      migrateSettingsState({
        keyboardShortcutOverrides: {
          "save-file": "Shift+Mod+k",
          "zoom-in": null,
          unknown: "Mod+KeyU",
        },
      }).keyboardShortcutOverrides,
    ).toEqual({
      "save-file": "Mod+Shift+KeyK",
      "zoom-in": null,
    });

    useSettingsStore
      .getState()
      .setKeyboardShortcut("save-file", "Mod+Shift+KeyK");
    useSettingsStore.getState().setKeyboardShortcut("zoom-in", null);
    expect(useSettingsStore.getState().keyboardShortcutOverrides).toEqual({
      "save-file": "Mod+Shift+KeyK",
      "zoom-in": null,
    });

    useSettingsStore.getState().setKeyboardShortcut("save-file", "Mod+KeyS");
    expect(useSettingsStore.getState().keyboardShortcutOverrides).toEqual({
      "zoom-in": null,
    });

    useSettingsStore.getState().resetKeyboardShortcuts();
    expect(useSettingsStore.getState().keyboardShortcutOverrides).toEqual({});
  });

  it("drops all retired prompt toggles while preserving custom instructions", () => {
    const migrated = migrateSettingsState({
      useProjectAgentPrompt: true,
      useClaudeAgentPrompt: true,
      useGlobalAgentPrompt: false,
      globalAgentPrompt: "Keep my Global prompt.",
    });
    expect(migrated).not.toHaveProperty("useProjectAgentPrompt");
    expect(migrated).not.toHaveProperty("useClaudeAgentPrompt");
    expect(migrated).toMatchObject({
      globalAgentPrompt: "Keep my Global prompt.",
    });
    expect(migrated).not.toHaveProperty("useGlobalAgentPrompt");
  });

  it("normalizes editor font size preferences from 8px to 22px", () => {
    expect(migrateSettingsState({ editorFontSize: 7 }).editorFontSize).toBe(8);
    expect(migrateSettingsState({ editorFontSize: 8 }).editorFontSize).toBe(8);
    expect(migrateSettingsState({ editorFontSize: 23 }).editorFontSize).toBe(
      22,
    );

    useSettingsStore.getState().setEditorFontSize(7);
    expect(useSettingsStore.getState().editorFontSize).toBe(8);
  });

  it("migrates the legacy Markdown theme into separate light and dark settings", () => {
    const migrated = migrateSettingsState({
      markdownThemeDirectory: "  /themes  ",
      markdownPreviewThemePath: "  /themes/academic.css  ",
    });

    expect(migrated.markdownThemeDirectory).toBe("/themes");
    expect(migrated.markdownLoadTyporaThemes).toBe(true);
    expect(migrated.markdownSeparateLightDarkThemes).toBe(true);
    expect(migrated.markdownPreviewTheme).toBe("/themes/academic.css");
    expect(migrated.markdownPreviewLightTheme).toBe("/themes/academic.css");
    expect(migrated.markdownPreviewDarkTheme).toBe("/themes/academic.css");

    const defaults = migrateSettingsState({});
    expect(defaults.markdownLoadTyporaThemes).toBe(true);
    expect(defaults.markdownMathEnginesByFile).toEqual({});
    expect(defaults.markdownPreviewTheme).toBe(GITHUB_LIGHT_MARKDOWN_THEME_ID);
    expect(defaults.markdownPreviewLightTheme).toBe(
      GITHUB_LIGHT_MARKDOWN_THEME_ID,
    );
    expect(defaults.markdownPreviewDarkTheme).toBe(
      GITHUB_DARK_MARKDOWN_THEME_ID,
    );
  });

  it("updates persistent Markdown theme settings", () => {
    useSettingsStore.getState().setMarkdownLoadTyporaThemes(false);
    useSettingsStore.getState().setMarkdownSeparateLightDarkThemes(false);

    useSettingsStore.getState().setMarkdownThemeDirectory("  /new-themes  ");
    useSettingsStore.getState().setMarkdownPreviewTheme("/new-themes/all.css");
    useSettingsStore
      .getState()
      .setMarkdownPreviewLightTheme("  /new-themes/light.css  ");
    useSettingsStore
      .getState()
      .setMarkdownPreviewDarkTheme("  /new-themes/dark.css  ");
    expect(useSettingsStore.getState().markdownThemeDirectory).toBe(
      "/new-themes",
    );
    expect(useSettingsStore.getState().markdownLoadTyporaThemes).toBe(false);
    expect(useSettingsStore.getState().markdownSeparateLightDarkThemes).toBe(
      false,
    );
    expect(useSettingsStore.getState().markdownPreviewTheme).toBe(
      "/new-themes/all.css",
    );
    expect(useSettingsStore.getState().markdownPreviewLightTheme).toBe(
      "/new-themes/light.css",
    );
    expect(useSettingsStore.getState().markdownPreviewDarkTheme).toBe(
      "/new-themes/dark.css",
    );

    useSettingsStore.getState().setMarkdownThemeDirectory(null);
    useSettingsStore.getState().setMarkdownPreviewTheme("");
    expect(useSettingsStore.getState().markdownThemeDirectory).toBeNull();
    expect(useSettingsStore.getState().markdownPreviewTheme).toBe(
      GITHUB_LIGHT_MARKDOWN_THEME_ID,
    );
  });

  it("preserves auto compiler engine preferences during migration", () => {
    const migrated = migrateSettingsState({
      compilerEngine: "auto",
    });

    expect(migrated.compilerEngine).toBe("auto");
  });

  it("defaults missing compiler engine preferences to Auto", () => {
    expect(migrateSettingsState({}).compilerEngine).toBe("auto");
  });

  it("defaults invalid compiler engine preferences to XeLaTeX", () => {
    const migrated = migrateSettingsState({
      compilerEngine: "unknown",
    });

    expect(migrated.compilerEngine).toBe("xelatex");
  });

  it("assigns an unspecified Auto default to concrete pdfLaTeX and preserves it on reload", () => {
    useSettingsStore.setState({
      compilerBackend: "latexmk",
      compilerEngine: "auto",
      compilerChoicesByRoot: {},
    });
    const choice = useSettingsStore
      .getState()
      .initializeCompilerChoiceForRoot("/project", "main.tex");
    expect(choice).toEqual({
      backend: "latexmk",
      engine: "pdflatex",
    });
    const migrated = migrateSettingsState({
      compilerChoicesByRoot: { root: choice },
    });
    expect(migrated.compilerChoicesByRoot.root).toEqual(choice);
  });

  it("initializes a latexmk auto root to the detected concrete engine once", () => {
    useSettingsStore.setState({
      compilerBackend: "latexmk",
      compilerEngine: "auto",
      compilerChoicesByRoot: {},
    });

    const initial = useSettingsStore
      .getState()
      .initializeCompilerChoiceForRoot("/project", "main.tex", "lualatex");
    expect(initial).toEqual({
      backend: "latexmk",
      engine: "lualatex",
    });

    useSettingsStore.setState({ compilerEngine: "pdflatex" });

    const existing = useSettingsStore
      .getState()
      .initializeCompilerChoiceForRoot("/project", "main.tex", "xelatex");
    expect(existing).toEqual({
      backend: "latexmk",
      engine: "lualatex",
    });
  });

  it("lets manual root compiler choices overwrite auto-initialized choices", () => {
    useSettingsStore.setState({
      compilerBackend: "latexmk",
      compilerEngine: "auto",
      compilerChoicesByRoot: {},
    });

    useSettingsStore
      .getState()
      .initializeCompilerChoiceForRoot("/project", "main.tex", "lualatex");
    useSettingsStore
      .getState()
      .setCompilerChoiceForRoot("/project", "main.tex", {
        backend: "latexmk",
        engine: "pdflatex",
      });

    expect(
      useSettingsStore
        .getState()
        .getCompilerChoiceForRoot("/project", "main.tex"),
    ).toEqual({ backend: "latexmk", engine: "pdflatex" });
  });
});

describe("recent Markdown themes", () => {
  it("preserves rows while evicting the least recently used theme and appending replacements", async () => {
    const store = useSettingsStore.getState;
    for (const path of ["A", "B", "C", "D", "E", "A", "C"])
      store().recordRecentMarkdownTheme(path);
    expect(store().recentMarkdownThemeOrder).toEqual(["A", "B", "C", "D", "E"]);
    store().recordRecentMarkdownTheme("F");
    expect(store().recentMarkdownThemeOrder).toEqual(["A", "C", "D", "E", "F"]);
    expect(store().recentMarkdownThemePaths).toEqual(["F", "C", "A", "E", "D"]);
    await useSettingsStore.persist.rehydrate();
    expect(store().recentMarkdownThemeOrder).toEqual(["A", "C", "D", "E", "F"]);
    store().recordRecentMarkdownTheme("G");
    expect(store().recentMarkdownThemeOrder).toEqual(["A", "C", "E", "F", "G"]);
  });

  it("restores older history and removes stale or duplicate display entries", () => {
    expect(
      migrateSettingsState({ recentMarkdownThemePaths: ["B", "A"] })
        .recentMarkdownThemeOrder,
    ).toEqual(["B", "A"]);
    expect(
      migrateSettingsState({
        recentMarkdownThemePaths: ["D", "C", "B", "A"],
        recentMarkdownThemeOrder: ["A", "missing", "A", "B", null],
      }).recentMarkdownThemeOrder,
    ).toEqual(["A", "B", "D", "C"]);
  });

  it("keeps at most five distinct paths in most-recently-used order", () => {
    for (let i = 1; i <= 7; i++)
      useSettingsStore.getState().recordRecentMarkdownTheme(`/themes/${i}.css`);
    useSettingsStore.getState().recordRecentMarkdownTheme("/themes/4.css");
    expect(useSettingsStore.getState().recentMarkdownThemePaths).toEqual([
      "/themes/4.css",
      "/themes/7.css",
      "/themes/6.css",
      "/themes/5.css",
      "/themes/3.css",
    ]);
    expect(
      migrateSettingsState({
        recentMarkdownThemePaths: ["/a.css", null, "/a.css", "", 3, "/b.css"],
      }).recentMarkdownThemePaths,
    ).toEqual(["/a.css", "/b.css"]);
  });
});

describe("per-file Markdown math engines", () => {
  it("applies the default only to files without an explicit engine choice", () => {
    const store = useSettingsStore.getState;
    store().setMarkdownMathEngineForFile("/one", "explicit.md", "katex");
    store().setDefaultMarkdownMathEngine("mathjax");
    expect(store().getMarkdownMathEngineForFile("/one", "inherited.md")).toBe(
      "mathjax",
    );
    expect(store().getMarkdownMathEngineForFile("/two", "inherited.md")).toBe(
      "mathjax",
    );
    expect(store().getMarkdownMathEngineForFile(null, null)).toBe("mathjax");
    expect(store().getMarkdownMathEngineForFile("/one", "explicit.md")).toBe(
      "katex",
    );
    store().setMarkdownMathEngineForFile("/one", "mathjax.md", "mathjax");
    store().setDefaultMarkdownMathEngine("katex");
    expect(store().getMarkdownMathEngineForFile("/one", "inherited.md")).toBe(
      "katex",
    );
    expect(store().getMarkdownMathEngineForFile("/one", "mathjax.md")).toBe(
      "mathjax",
    );
  });

  it("persists the default and falls back to KaTeX for missing or invalid values", async () => {
    expect(migrateSettingsState({}).defaultMarkdownMathEngine).toBe("katex");
    expect(
      migrateSettingsState({ defaultMarkdownMathEngine: "unknown" })
        .defaultMarkdownMathEngine,
    ).toBe("katex");
    expect(
      migrateSettingsState({ defaultMarkdownMathEngine: "mathjax" })
        .defaultMarkdownMathEngine,
    ).toBe("mathjax");
    useSettingsStore.getState().setDefaultMarkdownMathEngine("mathjax");
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().defaultMarkdownMathEngine).toBe(
      "mathjax",
    );
    const name = useSettingsStore.persist.getOptions().name!;
    const saved = JSON.parse(localStorage.getItem(name)!);
    saved.state.defaultMarkdownMathEngine = "unknown";
    localStorage.setItem(name, JSON.stringify(saved));
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().defaultMarkdownMathEngine).toBe("katex");
  });

  it("defaults to KaTeX and isolates choices by project and file", () => {
    const store = useSettingsStore.getState;
    expect(store().getMarkdownMathEngineForFile("/one", "notes.md")).toBe(
      "katex",
    );
    store().setMarkdownMathEngineForFile("/one", "notes.md", "mathjax");
    expect(store().getMarkdownMathEngineForFile("/one", "notes.md")).toBe(
      "mathjax",
    );
    expect(store().getMarkdownMathEngineForFile("/one", "other.md")).toBe(
      "katex",
    );
    expect(store().getMarkdownMathEngineForFile("/two", "notes.md")).toBe(
      "katex",
    );
    expect(store().getMarkdownMathEngineForFile(null, "notes.md")).toBe(
      "katex",
    );
    store().setMarkdownMathEngineForFile("/one", "other.md", "mathjax");
    store().setMarkdownMathEngineForFile("/one", "notes.md", "katex");
    expect(store().getMarkdownMathEngineForFile("/one", "notes.md")).toBe(
      "katex",
    );
    expect(store().getMarkdownMathEngineForFile("/one", "other.md")).toBe(
      "mathjax",
    );
  });

  it("rehydrates saved file choices and filters invalid entries", async () => {
    const key = JSON.stringify(["/project", "notes.md"]);
    const choices = { [key]: "mathjax", invalid: "unknown" };
    expect(
      migrateSettingsState({ markdownMathEnginesByFile: choices })
        .markdownMathEnginesByFile,
    ).toEqual({ [key]: "mathjax" });
    expect(
      migrateSettingsState({ markdownMathEngine: "mathjax" })
        .markdownMathEnginesByFile,
    ).toEqual({});
    const name = useSettingsStore.persist.getOptions().name!;
    const saved = JSON.parse(localStorage.getItem(name)!);
    saved.state.markdownMathEnginesByFile = choices;
    localStorage.setItem(name, JSON.stringify(saved));
    await useSettingsStore.persist.rehydrate();
    expect(
      useSettingsStore
        .getState()
        .getMarkdownMathEngineForFile("/project", "notes.md"),
    ).toBe("mathjax");
    expect(useSettingsStore.getState().markdownMathEnginesByFile).toEqual({
      [key]: "mathjax",
    });
  });
});

describe("comment visibility", () => {
  it("defaults both controls on and preserves the PDF preference while hidden", () => {
    expect(useSettingsStore.getInitialState().displayComments).toBe(true);
    expect(useSettingsStore.getInitialState().showPdfComments).toBe(true);
    useSettingsStore.getState().setShowPdfComments(true);
    useSettingsStore.getState().setDisplayComments(false);
    expect(useSettingsStore.getState().showPdfComments).toBe(true);
    useSettingsStore.getState().setDisplayComments(true);
    expect(useSettingsStore.getState().showPdfComments).toBe(true);
  });
});

describe("tooltip preferences", () => {
  it("defaults older profiles to visible, delayed hints and normalizes malformed values", () => {
    expect(migrateSettingsState({})).toMatchObject({
      showTooltips: true,
      tooltipHoverDelay: true,
    });
    expect(
      migrateSettingsState({ showTooltips: "false", tooltipHoverDelay: null }),
    ).toMatchObject({ showTooltips: true, tooltipHoverDelay: true });
    expect(
      migrateSettingsState({ showTooltips: false, tooltipHoverDelay: false }),
    ).toMatchObject({ showTooltips: false, tooltipHoverDelay: false });
  });

  it("persists both preferences and receives another window's updates", async () => {
    useSettingsStore.getState().setShowTooltips(false);
    useSettingsStore.getState().setTooltipHoverDelay(false);
    const saved = localStorage.getItem("catalex-settings") as string;
    expect(JSON.parse(saved).state).toMatchObject({
      showTooltips: false,
      tooltipHoverDelay: false,
    });
    useSettingsStore.setState({ showTooltips: true, tooltipHoverDelay: true });
    localStorage.setItem("catalex-settings", saved);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "catalex-settings",
        newValue: saved,
      }),
    );
    expect(useSettingsStore.getState()).toMatchObject({
      showTooltips: false,
      tooltipHoverDelay: false,
    });
    useSettingsStore.setState({ showTooltips: true, tooltipHoverDelay: true });
  });
});

describe("project automatic compilation", () => {
  it("migrates the old app toggle to a default and validates project entries", () => {
    expect(migrateSettingsState({}).defaultAutoCompile).toBe(true);
    expect(
      migrateSettingsState({ autoCompile: "false" }).defaultAutoCompile,
    ).toBe(true);
    const migrated = migrateSettingsState({
      autoCompile: false,
      autoCompileByProject: {
        "/one": false,
        "/two": true,
        "/invalid": "false",
      },
    });
    expect(migrated.defaultAutoCompile).toBe(false);
    expect(migrated).not.toHaveProperty("autoCompile");
    expect(migrated.autoCompileByProject).toEqual({
      "/one": false,
      "/two": true,
    });
  });

  it("captures the default once per project and keeps project choices independent", () => {
    const settings = useSettingsStore.getState;
    expect(settings().initializeProjectAutoCompile("/one")).toBe(true);
    settings().setDefaultAutoCompile(false);
    expect(settings().initializeProjectAutoCompile("/one")).toBe(true);
    expect(settings().initializeProjectAutoCompile("/two")).toBe(false);
    settings().setProjectAutoCompile("/one", false);
    settings().setDefaultAutoCompile(true);
    expect(settings().getProjectAutoCompile("/one")).toBe(false);
    expect(settings().getProjectAutoCompile("/two")).toBe(false);
    expect(settings().initializeProjectAutoCompile("/three")).toBe(true);
  });

  it("persists and synchronizes the saved project map across windows", async () => {
    useSettingsStore.getState().setProjectAutoCompile("/one", false);
    useSettingsStore.getState().setProjectAutoCompile("/two", true);
    const saved = localStorage.getItem("catalex-settings")!;
    expect(JSON.parse(saved).state.autoCompileByProject).toEqual({
      "/one": false,
      "/two": true,
    });
    useSettingsStore.setState({ autoCompileByProject: {} });
    localStorage.setItem("catalex-settings", saved);
    window.dispatchEvent(
      new StorageEvent("storage", { key: "catalex-settings" }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().getProjectAutoCompile("/one")).toBe(
      false,
    );
    expect(useSettingsStore.getState().getProjectAutoCompile("/two")).toBe(
      true,
    );
  });

  it("converts previously saved Auto compiler records to concrete choices", async () => {
    const choice = { backend: "latexmk", engine: "lualatex", autoEngine: true };
    expect(
      migrateSettingsState({ compilerChoicesByRoot: { old: choice } })
        .compilerChoicesByRoot.old,
    ).toEqual({ backend: "latexmk", engine: "lualatex" });
    const saved = JSON.parse(localStorage.getItem("catalex-settings")!);
    saved.state.compilerChoicesByRoot = { old: choice };
    localStorage.setItem("catalex-settings", JSON.stringify(saved));
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().compilerChoicesByRoot.old).toEqual({
      backend: "latexmk",
      engine: "lualatex",
    });
  });
});

describe("spelling settings", () => {
  it("persists the toggle, language and deduplicated personal words", async () => {
    const store = useSettingsStore.getState;
    useSettingsStore.setState({ spellingWords: [] });
    store().setSpellCheck(false);
    store().setSpellingLanguage("en-GB");
    store().learnSpellingWord("Catalex");
    store().learnSpellingWord("Catalex");
    store().learnSpellingWord("");
    const saved = localStorage.getItem("catalex-settings")!;
    useSettingsStore.setState({
      spellCheck: true,
      spellingLanguage: "en-US",
      spellingWords: [],
    });
    localStorage.setItem("catalex-settings", saved);
    await useSettingsStore.persist.rehydrate();
    expect(store().spellCheck).toBe(false);
    expect(store().spellingLanguage).toBe("en-GB");
    expect(store().spellingWords).toEqual(["Catalex"]);
  });
  it("normalizes absent or damaged spelling preferences", () => {
    const state = migrateSettingsState({
      spellCheck: "yes",
      spellingLanguage: "invalid",
      spellingWords: ["Catalex", "Catalex", null, 3, ""],
    });
    expect(state.spellCheck).toBe(true);
    expect(state.spellingLanguage).toBe("en-US");
    expect(state.spellingWords).toEqual(["Catalex"]);
  });
});

describe("saved Pi paths", () => {
  beforeEach(() =>
    useSettingsStore.setState({
      piBinaryPath: "",
      piConfigDirectory: "",
      piBinaryPaths: null,
      piConfigDirectories: null,
    }),
  );
  it("migrates existing overrides and preserves an intentionally empty list", () => {
    const migrated = migrateSettingsState({
      piBinaryPath: " /legacy/pi ",
      piConfigDirectory: "/legacy/config",
    });
    expect(migrated.piBinaryPaths).toEqual(["/legacy/pi"]);
    expect(migrated.piConfigDirectories).toEqual(["/legacy/config"]);
    expect(migrateSettingsState({}).piBinaryPaths).toBeNull();
    expect(migrateSettingsState({ piBinaryPaths: [] }).piBinaryPaths).toEqual(
      [],
    );
  });
  it("deduplicates paths and removes selected or unselected entries", () => {
    const state = useSettingsStore.getState;
    state().setPiBinaryPath(" /one ");
    state().setPiBinaryPath("/two");
    state().setPiBinaryPath("/two");
    expect(state().piBinaryPaths).toEqual(["/one", "/two"]);
    state().removePiBinaryPath("/one");
    expect(state().piBinaryPath).toBe("/two");
    state().setPiBinaryPath("/three");
    state().removePiBinaryPath("/three");
    expect(state().piBinaryPath).toBe("/two");
    state().removePiBinaryPath("/two");
    expect(state().piBinaryPath).toBe("");
    expect(state().piBinaryPaths).toEqual([]);
  });
  it("persists both option lists and selected paths across rehydration", async () => {
    const state = useSettingsStore.getState;
    state().setPiBinaryPath("/bin one");
    state().setPiBinaryPath("/bin two");
    state().setPiConfigDirectory("/config one");
    state().setPiConfigDirectory("/config two");
    const saved = localStorage.getItem("catalex-settings")!;
    useSettingsStore.setState({
      piBinaryPaths: null,
      piConfigDirectories: null,
      piBinaryPath: "",
      piConfigDirectory: "",
    });
    localStorage.setItem("catalex-settings", saved);
    await useSettingsStore.persist.rehydrate();
    expect(state().piBinaryPaths).toEqual(["/bin one", "/bin two"]);
    expect(state().piConfigDirectories).toEqual(["/config one", "/config two"]);
    expect(state().piBinaryPath).toBe("/bin two");
    expect(state().piConfigDirectory).toBe("/config two");
  });
});

it("preserves a previously saved skip and normalizes per-version skip lists", () => {
  const merge = useSettingsStore.persist.getOptions().merge!;
  const state = useSettingsStore.getState();
  expect(
    merge({ skippedUpdateVersion: "0.1.1-beta" }, state).skippedUpdateVersions,
  ).toEqual(["0.1.1-beta"]);
  expect(
    merge(
      {
        skippedUpdateVersions: [
          "0.1.1-beta",
          null,
          "",
          "0.1.1-beta",
          "0.1.2-beta",
        ],
      },
      state,
    ).skippedUpdateVersions,
  ).toEqual(["0.1.1-beta", "0.1.2-beta"]);
  expect(
    merge(
      { skippedUpdateVersions: [], skippedUpdateVersion: "0.1.1-beta" },
      state,
    ).skippedUpdateVersions,
  ).toEqual([]);
});

describe("saved prompt library", () => {
  it("upgrades saved stock icons once and preserves custom choices", async () => {
    const [writing, , review, layout] = DEFAULT_PROMPT_LIBRARY;
    const customReview = { ...review, icon: "quote" as const };
    localStorage.setItem(
      "catalex-settings",
      JSON.stringify({
        version: 26,
        state: {
          promptLibrary: [
            { ...layout, icon: "target" },
            customReview,
            { ...writing, icon: "list-tree" },
          ],
        },
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().promptLibrary).toEqual([
      layout,
      customReview,
      writing,
    ]);
    const edited = { ...writing, icon: "list-tree" as const };
    useSettingsStore.getState().saveLibraryPrompt(edited);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().promptLibrary[2]).toEqual(edited);
  });

  it("persists the shared prompt pin under its original key and explicit unpin", async () => {
    const store = useSettingsStore.getState;
    store().setKeepMiniPromptsOpen(true);
    await useSettingsStore.persist.rehydrate();
    expect(store().keepMiniPromptsOpen).toBe(true);
    store().setKeepMiniPromptsOpen(false);
    await useSettingsStore.persist.rehydrate();
    expect(store().keepMiniPromptsOpen).toBe(false);
  });
  it("loads defaults for older settings without resetting global instructions", async () => {
    localStorage.setItem(
      "catalex-settings",
      JSON.stringify({
        version: 26,
        state: { globalAgentPrompt: "Keep my instructions" },
      }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(
      useSettingsStore.getState().promptLibrary.map((prompt) => prompt.id),
    ).toEqual([
      "improve-writing",
      "fix-issues",
      "review-and-comment",
      "tighten-layout",
    ]);
    expect(useSettingsStore.getState().globalAgentPrompt).toBe(
      "Keep my instructions",
    );
    expect(useSettingsStore.getState().keepMiniPromptsOpen).toBe(false);
  });
  it("retains custom text, ordering, disabled prompts, and deliberate deletion after rehydration", async () => {
    useSettingsStore.setState({ promptLibrary: [] });
    const store = useSettingsStore.getState;
    const prompt = {
      id: "custom",
      title: "Custom",
      prompt: "My prompt",
      availability: "always" as const,
      enabled: false,
    };
    store().saveLibraryPrompt(prompt);
    store().saveLibraryPrompt({ ...prompt, id: "second", title: "Second" });
    store().moveLibraryPrompt("second", -1);
    await useSettingsStore.persist.rehydrate();
    expect(store().promptLibrary.map((item) => item.id)).toEqual([
      "second",
      "custom",
    ]);
    expect(store().promptLibrary[1]).toEqual(prompt);
    store().deleteLibraryPrompt("second");
    store().deleteLibraryPrompt("custom");
    await useSettingsStore.persist.rehydrate();
    expect(store().promptLibrary).toEqual([]);
  });
});

it("reorders visible built-ins past hidden prompts while preserving saved custom content", () => {
  const [writing, fix, review, layout] = DEFAULT_PROMPT_LIBRARY;
  const edited = {
    ...writing,
    title: "Edited writing",
    prompt: "Keep my text",
  };
  const custom = { ...writing, id: "custom", title: "My custom prompt" };
  useSettingsStore.setState({ promptLibrary: [edited, custom, fix] });
  const visible = visiblePromptLibrary(
    useSettingsStore.getState().promptLibrary,
  ).map((item) => item.id);
  useSettingsStore.getState().moveLibraryPrompt(fix.id, -1, visible);
  expect(
    visiblePromptLibrary(useSettingsStore.getState().promptLibrary).map(
      (item) => item.id,
    ),
  ).toEqual([fix.id, writing.id, review.id, layout.id]);
  expect(useSettingsStore.getState().promptLibrary).toEqual([
    fix,
    custom,
    edited,
    review,
    layout,
  ]);
});
