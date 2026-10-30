import { useProjectStore } from "@/stores/project-store";
import { useRef } from "react";
import { ThemeProvider } from "next-themes";
import { SettingsWindow } from "@/components/settings/settings-window";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";
import { browserHarness } from "@/lib/desktop/bridge";
import type {
  StorageInventory,
  StoredProject,
} from "../../../main/managed-storage";

const MB = 1024 ** 2;
function fixture(
  id: string,
  name: string,
  overrides: Partial<StoredProject> = {},
): StoredProject {
  return {
    id,
    name,
    paths: [`/Users/researcher/Papers/${name}`],
    sourceAvailable: true,
    isOpen: false,
    isRecent: false,
    historyBytes: 180 * MB,
    agentBytes: 24 * MB,
    cacheBytes: 32 * MB,
    otherBytes: 1024,
    totalBytes: 236 * MB + 1024,
    historyLimitBytes: 250 * MB,
    dataPath: `/app/projects/${id}`,
    cachePath: `/cache/projects/${id}`,
    ...overrides,
  };
}
export function StorageSettingsHarness() {
  const initialized = useRef(false);
  const params = new URLSearchParams(window.location.search);
  if (!initialized.current) {
    initialized.current = true;
    ensureDesktopBrowserMocks();
    useProjectStore.setState({
      recentProjects: [
        {
          path: "/Users/researcher/Papers/Current manuscript",
          name: "Current manuscript",
          lastOpened: 1,
        },
        {
          path: "/Volumes/Research/Papers/Archived study",
          name: "Archived study",
          lastOpened: 1,
        },
      ],
    });
    const harness = browserHarness()!;
    const fallback = harness.invoke.bind(harness);
    let browserCacheBytes = 850 * MB;
    let projects = params.has("emptyStorage")
      ? []
      : [
          fixture("paper", "Research paper"),
          fixture("open", "Current manuscript", { isOpen: true }),
          fixture("missing", "Archived study", {
            sourceAvailable: false,
            paths: ["/Volumes/Research/Papers/Archived study"],
          }),
        ];
    harness.invoke = async (command, args) => {
      const values = (args ?? {}) as Record<string, unknown>;
      if (command === "desktop:storage:list") {
        if (params.has("listFailure"))
          throw new Error("Could not read stored project inventory.");
        return {
          projects: structuredClone(projects).map((project) => ({
            ...project,
            isRecent: project.paths.some((path) =>
              ((values.recentPaths as string[]) ?? []).includes(path),
            ),
          })),
          totalBytes:
            projects.reduce((sum, project) => sum + project.totalBytes, 0) +
            10 * MB +
            browserCacheBytes,
          sharedBytes: 2 * MB,
          profileBytes: 8 * MB,
          browserCacheBytes,
          dataPath: "/app",
          cachePath: "/cache",
          profilePath: "/profile",
        } satisfies StorageInventory;
      }
      if (command === "desktop:storage:clear-browser-cache") {
        if (params.has("clearFailure"))
          throw new Error("Could not clear browser cache.");
        browserCacheBytes = 0;
        return null;
      }
      if (command === "desktop:storage:clear") {
        if (params.has("clearFailure"))
          throw new Error(
            "Close this project in every window before managing its stored data.",
          );
        const project = projects.find(
          (project) => project.id === values.projectId,
        )!;
        if (values.action === "all")
          projects = projects.filter((entry) => entry !== project);
        else if (values.action === "history") {
          project.totalBytes -= project.historyBytes;
          project.historyBytes = 0;
        } else if (values.action === "cache") {
          project.totalBytes -= project.cacheBytes;
          project.cacheBytes = 0;
        } else {
          project.totalBytes -= project.agentBytes;
          project.agentBytes = 0;
        }
        return null;
      }
      if (command === "desktop:storage:limit") {
        projects.find(
          (project) => project.id === values.projectId,
        )!.historyLimitBytes = Number(values.bytes);
        return null;
      }
      if (command === "desktop:storage:reveal") return null;
      return fallback(command, args);
    };
  }
  return (
    <ThemeProvider
      attribute="class"
      forcedTheme={params.get("theme") === "dark" ? "dark" : "light"}
    >
      <div data-testid="storage-settings-harness">
        <SettingsWindow />
      </div>
    </ThemeProvider>
  );
}
