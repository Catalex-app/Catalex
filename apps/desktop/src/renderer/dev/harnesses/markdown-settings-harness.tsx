import { useRef } from "react";
import { ThemeProvider } from "next-themes";
import { SettingsWindow } from "@/components/settings/settings-window";
import { useSettingsStore } from "@/stores/settings-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";
import {
  GITHUB_DARK_MARKDOWN_THEME_ID,
  GITHUB_LIGHT_MARKDOWN_THEME_ID,
} from "@/lib/markdown-theme";

export function MarkdownSettingsHarness() {
  ensureDesktopBrowserMocks();
  const initializedRef = useRef(false);
  if (!initializedRef.current) {
    initializedRef.current = true;
    useSettingsStore.setState({
      markdownLoadTyporaThemes: true,
      markdownThemeDirectory: null,
      markdownSeparateLightDarkThemes: true,
      markdownPreviewTheme: GITHUB_LIGHT_MARKDOWN_THEME_ID,
      markdownPreviewLightTheme: GITHUB_LIGHT_MARKDOWN_THEME_ID,
      markdownPreviewDarkTheme: GITHUB_DARK_MARKDOWN_THEME_ID,
      keyboardShortcutOverrides: {},
    });
  }

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <div data-testid="markdown-settings-harness-shell">
        <SettingsWindow />
      </div>
    </ThemeProvider>
  );
}
