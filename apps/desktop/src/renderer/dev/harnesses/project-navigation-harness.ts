import { useDocumentStore } from "@/stores/document-store";
import { browserHarness } from "@/lib/desktop/bridge";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

const PROJECT_ROOT = "/tmp/catalex-navigation/Research notes";
const CONTENT = "# Research notes\n\nA place to develop ideas and write.\n";

declare global {
  interface Window {
    __projectNavigationHarness?: {
      failOpen: boolean;
      failSave: boolean;
      content: string;
      holdOpen: boolean;
      releaseOpen: (() => void) | null;
      openAttempts: number;
    };
  }
}

/** The real App and project lifecycle, backed by an in-memory folder. */
export function initializeProjectNavigationHarness() {
  ensureDesktopBrowserMocks();
  const harness: NonNullable<Window["__projectNavigationHarness"]> = {
    failOpen: false,
    failSave: false,
    content: CONTENT,
    holdOpen: false,
    releaseOpen: null,
    openAttempts: 0,
  };
  window.__projectNavigationHarness = harness;
  const bridge = browserHarness()!;
  const invoke = bridge.invoke;
  bridge.invoke = async (command, payload, options) => {
    const args = payload as Record<string, unknown> | undefined;
    const path = args?.path;
    if (command === "plugin:path|join")
      return (args?.paths as string[]).join("/");
    if (command === "plugin:dialog|open") return PROJECT_ROOT;
    if (
      command === "plugin:fs|exists" &&
      (path === PROJECT_ROOT || path === `${PROJECT_ROOT}/notes.md`)
    )
      return true;
    if (command === "plugin:fs|read_dir" && path === PROJECT_ROOT) {
      harness.openAttempts++;
      if (harness.holdOpen)
        await new Promise<void>((resolve) => {
          harness.releaseOpen = () => {
            harness.holdOpen = false;
            harness.releaseOpen = null;
            resolve();
          };
        });
      if (harness.failOpen) throw new Error("The project could not be read.");
      return [{ name: "notes.md", isDirectory: false, isFile: true }];
    }
    if (
      command === "plugin:fs|read_text_file" &&
      path === `${PROJECT_ROOT}/notes.md`
    )
      return harness.content;
    if (command === "plugin:fs|stat" && path === `${PROJECT_ROOT}/notes.md`)
      return { size: harness.content.length, isFile: true, mtime: null };
    if (command === "save_file_if_unchanged") {
      if (harness.failSave) throw new Error("The project could not be saved.");
      harness.content = String(args?.content);
      return { written: true, current: harness.content };
    }
    return invoke(command, payload, options);
  };
  useOnboardingStore.setState({ completed: true });
  useSettingsStore.setState({ defaultAutoCompile: false });
  useDocumentStore.setState({ projectRoot: null, initialized: false });
  useProjectStore.setState({
    recentProjects: [
      { path: PROJECT_ROOT, name: "Research notes", lastOpened: Date.now() },
      {
        path: "/tmp/catalex-navigation/Conference paper",
        name: "Conference paper",
        lastOpened:
          new URLSearchParams(location.search).get("returnTarget") === "middle"
            ? Date.now() + 60_000
            : Date.now() - 1000,
      },
      {
        path: "/tmp/catalex-navigation/Reading journal",
        name: "Reading journal",
        lastOpened: Date.now() - 2000,
      },
    ],
  });
}
