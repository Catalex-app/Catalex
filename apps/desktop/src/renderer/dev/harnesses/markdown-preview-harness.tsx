import { Hint } from "@/components/ui/tooltip";
import { useAgentEvents } from "@/hooks/use-agent-events";
import { useEffect, useRef, useState } from "react";
import { FileCodeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LatexEditor } from "@/components/workspace/editor/latex-editor";
import { MarkdownPreview } from "@/components/workspace/preview/markdown-preview";
import { SyncNavigationControl } from "@/components/workspace/sync-navigation-control";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";
import {
  GITHUB_DARK_MARKDOWN_THEME_ID,
  GITHUB_LIGHT_MARKDOWN_THEME_ID,
} from "@/lib/markdown-theme";
import { ThemeProvider, useTheme } from "next-themes";

const SAMPLE_MARKDOWN = `# Markdown Preview

Live **GitHub-flavored Markdown** with [a local link](notes.md).

> A blockquote rendered in the preview.

- [x] Live rendering
- [ ] Typora theme compatibility

| Feature | Status |
| --- | --- |
| Tables | Ready |
| Math | $E = mc^2$ |

\`\`\`ts
const preview = "live";
\`\`\`

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

## Reading notes

Markdown keeps source and preview close together while longer documents grow.

### Section one

The first section provides enough content to exercise preview scrolling. Its source position is attached to the rendered block.

### Section two

The second section confirms that synchronization follows semantic Markdown blocks instead of a raw scroll percentage.

### Section three

The third section keeps the rendered document moving through the viewport with stable source anchors.

### Section four

Double-clicking this heading should locate the matching source position in the editor.

### Section five

The fifth section continues the document so the viewport center can resolve a meaningful source location.

### Sync destination

The editor-to-preview button should center this final section in the rendered preview.
`;

const TYPORA_THEME = `
body { background: #f8f2e8; color: #2f2923; }
#write { max-width: 760px; font-family: Georgia, serif; }
#write h1 { color: rgb(126, 58, 47); border-bottom: 2px solid currentColor; }
`;

function initializeMarkdownHarnessState() {
  useSettingsStore.setState({
    markdownLoadTyporaThemes: true,
    markdownThemeDirectory: null,
    markdownSeparateLightDarkThemes: true,
    markdownPreviewTheme: GITHUB_LIGHT_MARKDOWN_THEME_ID,
    markdownPreviewLightTheme: GITHUB_LIGHT_MARKDOWN_THEME_ID,
    markdownPreviewDarkTheme: GITHUB_DARK_MARKDOWN_THEME_ID,
  });
  useDocumentStore.setState({
    projectRoot: "/tmp/markdown-preview-harness",
    files: [
      {
        id: "README.md",
        name: "README.md",
        relativePath: "README.md",
        absolutePath: "/tmp/markdown-preview-harness/README.md",
        type: "other",
        content: SAMPLE_MARKDOWN,
        isDirty: false,
      },
      {
        id: "notes.md",
        name: "notes.md",
        relativePath: "notes.md",
        absolutePath: "/tmp/markdown-preview-harness/notes.md",
        type: "other",
        content: "# Linked note",
        isDirty: false,
      },
      {
        id: "themes/academic.css",
        name: "academic.css",
        relativePath: "themes/academic.css",
        absolutePath: "/tmp/markdown-preview-harness/themes/academic.css",
        type: "other",
        content: TYPORA_THEME,
        isDirty: false,
      },
    ],
    folders: ["themes"],
    activeFileId: "README.md",
    openFileIds: ["README.md"],
    cursorPosition: 0,
    selectionRange: null,
    jumpToPosition: null,
    initialized: true,
  });
}

export function MarkdownPreviewHarness() {
  useAgentEvents();
  ensureDesktopBrowserMocks();
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <MarkdownPreviewHarnessContent />
    </ThemeProvider>
  );
}

function MarkdownPreviewHarnessContent() {
  const [editorVisible, setEditorVisible] = useState(true);
  const { resolvedTheme, setTheme } = useTheme();
  const [syncNavigationRequest, setSyncNavigationRequest] = useState<{
    id: number;
    direction: "to-editor" | "to-preview";
  } | null>(null);
  const [scrollSyncLocked, setScrollSyncLocked] = useState(true);
  const [previewScrollTarget, setPreviewScrollTarget] = useState<{
    id: number;
    position: number;
  } | null>(null);
  const [editorScrollTarget, setEditorScrollTarget] = useState<{
    id: number;
    position: number;
  } | null>(null);
  const previewScrollRequestIdRef = useRef(0);
  const editorScrollRequestIdRef = useRef(0);
  const cursorPosition = useDocumentStore((state) => state.cursorPosition);
  const separateMarkdownThemes = useSettingsStore(
    (state) => state.markdownSeparateLightDarkThemes,
  );
  const loadTyporaThemes = useSettingsStore(
    (state) => state.markdownLoadTyporaThemes,
  );

  useEffect(() => {
    setTheme("light");
    initializeMarkdownHarnessState();
  }, []);

  return (
    <div
      className="flex h-screen w-screen flex-col bg-muted p-4"
      data-testid="markdown-preview-harness-shell"
    >
      <div className="mb-3 flex items-center gap-3">
        <h1 className="font-semibold text-sm">Markdown preview harness</h1>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            useDocumentStore
              .getState()
              .updateFileContent(
                "README.md",
                SAMPLE_MARKDOWN.replace("Markdown Preview", "Updated Preview"),
              )
          }
        >
          Update content
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            useSettingsStore
              .getState()
              .setMarkdownThemeDirectory("/tmp/typora-themes");
            useSettingsStore
              .getState()
              .setMarkdownPreviewLightTheme("/tmp/typora-themes/Academic.css");
            useSettingsStore
              .getState()
              .setMarkdownPreviewDarkTheme("/tmp/typora-themes/Academic.css");
          }}
        >
          Use configured Typora theme
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          Switch to {resolvedTheme === "dark" ? "light" : "dark"} mode
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            useSettingsStore
              .getState()
              .setMarkdownSeparateLightDarkThemes(!separateMarkdownThemes)
          }
        >
          Use {separateMarkdownThemes ? "shared" : "separate"} theme mode
        </Button>
        <Hint
          content={`${loadTyporaThemes ? "Disable" : "Enable"} Typora theme loading`}
        >
          <Button
            size="icon"
            variant="outline"
            className="size-8 shrink-0"
            aria-label={`${loadTyporaThemes ? "Disable" : "Enable"} Typora theme loading`}
            onClick={() =>
              useSettingsStore
                .getState()
                .setMarkdownLoadTyporaThemes(!loadTyporaThemes)
            }
          >
            <FileCodeIcon className="size-3.5" />
          </Button>
        </Hint>
        <Button
          size="icon"
          variant="outline"
          className="size-8 shrink-0"
          aria-label="Toggle editor"
          onClick={() => setEditorVisible((value) => !value)}
        >
          <FileCodeIcon className="size-3.5" />
        </Button>
        <span className="ml-auto text-muted-foreground text-xs">
          Editor cursor:{" "}
          <span data-testid="markdown-editor-cursor-position">
            {cursorPosition}
          </span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          className="min-h-0 w-1/2 overflow-hidden rounded-panel border border-border/70 bg-card"
          style={{ display: editorVisible ? undefined : "none" }}
          data-testid="markdown-source-fixture"
        >
          <LatexEditor
            assistantMode="artisan"
            suppressToolbar
            scrollSyncEnabled={scrollSyncLocked}
            scrollSyncTarget={editorScrollTarget}
            onScrollPositionChange={(position) => {
              if (!scrollSyncLocked) return;
              previewScrollRequestIdRef.current += 1;
              setPreviewScrollTarget({
                id: previewScrollRequestIdRef.current,
                position,
              });
            }}
          />
        </div>
        <div className="relative w-2 shrink-0 bg-transparent">
          <SyncNavigationControl
            previewLabel="preview"
            onScrollSyncEnabledChange={(enabled) => {
              setScrollSyncLocked(enabled);
              setPreviewScrollTarget(null);
              setEditorScrollTarget(null);
              if (!enabled) return;
              previewScrollRequestIdRef.current += 1;
              setPreviewScrollTarget({
                id: previewScrollRequestIdRef.current,
                position:
                  useDocumentStore.getState().selectionRange?.start ??
                  useDocumentStore.getState().cursorPosition,
              });
            }}
            scrollSyncLocked={scrollSyncLocked}
            onNavigateToPreview={() => {
              useDocumentStore
                .getState()
                .setCursorPosition(
                  SAMPLE_MARKDOWN.indexOf("### Sync destination"),
                );
              setSyncNavigationRequest({
                id: Date.now(),
                direction: "to-preview",
              });
            }}
            onNavigateToEditor={() => {
              setSyncNavigationRequest({
                id: Date.now() + 1,
                direction: "to-editor",
              });
            }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-panel border border-border/70 bg-card">
          <MarkdownPreview
            editorVisible={editorVisible}
            syncNavigationRequest={syncNavigationRequest}
            onSyncNavigationHandled={(id) => {
              setSyncNavigationRequest((request) =>
                request?.id === id ? null : request,
              );
            }}
            scrollSyncEnabled={scrollSyncLocked}
            scrollSyncTarget={previewScrollTarget}
            onScrollSyncToEditor={(position) => {
              editorScrollRequestIdRef.current += 1;
              setEditorScrollTarget({
                id: editorScrollRequestIdRef.current,
                position,
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function MarkdownWorkspaceHarness() {
  ensureDesktopBrowserMocks();

  useEffect(() => {
    initializeMarkdownHarnessState();
  }, []);

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <div
        className="h-screen min-h-0 bg-background"
        data-testid="markdown-workspace-harness-shell"
      >
        <WorkspaceLayout />
      </div>
    </ThemeProvider>
  );
}
