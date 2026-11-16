import { createPanelStore } from "@/lib/panel-window-runtime";
import { persist } from "zustand/middleware";
import { synchronizePersistedStore } from "@/lib/persisted-store-sync";

interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
  lastActiveFile?: string;
}

export interface LatexProjectOptions {
  rootFolder: string;
  mainFile: string | null;
}
export const DEFAULT_LATEX_PROJECT_OPTIONS: LatexProjectOptions = {
  rootFolder: "",
  mainFile: null,
};

interface ProjectState {
  latexOptionsByProject: Record<string, LatexProjectOptions>;
  setLatexProjectOptions: (path: string, options: LatexProjectOptions) => void;
  recentProjects: RecentProject[];
  recentFilesByProject: Record<string, { recent: string[]; order: string[] }>;
  recordRecentFileSelection: (
    path: string,
    fileId: string,
    availableFileIds: string[],
  ) => void;
  sidebarWidthsByProject: Record<string, number>;
  setProjectSidebarWidth: (path: string, width: number | null) => void;
  lastProjectFolder: string | null;
  addRecentProject: (path: string) => void;
  removeRecentProject: (path: string) => void;
  setRecentProjectLastActiveFile: (path: string, fileId: string) => void;
  setLastProjectFolder: (path: string) => void;
}

const MAX_RECENT = 10;
export const MIN_PROJECT_SIDEBAR_WIDTH = 200;
export const MAX_PROJECT_SIDEBAR_WIDTH = 420;

export const useProjectStore = createPanelStore("projects")<ProjectState>()(
  persist(
    (set) => ({
      latexOptionsByProject: {},
      setLatexProjectOptions: (path, options) => {
        const validPath = (value: string) =>
          !value.includes("\\") &&
          !value.includes(":") &&
          value
            .split("/")
            .every((part) => part.length > 0 && !part.startsWith("."));
        if (options.rootFolder && !validPath(options.rootFolder)) return;
        if (options.mainFile && !validPath(options.mainFile)) return;
        set((state) => ({
          latexOptionsByProject: {
            ...state.latexOptionsByProject,
            [path]: options,
          },
        }));
      },
      recentProjects: [],
      recentFilesByProject: {},
      recordRecentFileSelection: (path, fileId, availableFileIds) => {
        const available = new Set(availableFileIds);
        if (!available.has(fileId)) return;
        set((state) => {
          const previous = state.recentFilesByProject[path];
          // Recency controls eviction; retained rows keep their display order.
          const recent = [
            fileId,
            ...(previous?.recent ?? []).filter(
              (id) => id !== fileId && available.has(id),
            ),
          ].slice(0, 5);
          const kept = (previous?.order ?? []).filter((id) =>
            recent.includes(id),
          );
          const order = [...kept, ...recent.filter((id) => !kept.includes(id))];
          return {
            recentFilesByProject: {
              ...state.recentFilesByProject,
              [path]: { recent, order },
            },
          };
        });
      },
      sidebarWidthsByProject: {},
      setProjectSidebarWidth: (path, width) => {
        if (width !== null && !Number.isFinite(width)) return;
        set((state) => {
          const widths = { ...state.sidebarWidthsByProject };
          if (width === null) delete widths[path];
          else
            widths[path] = Math.min(
              MAX_PROJECT_SIDEBAR_WIDTH,
              Math.max(MIN_PROJECT_SIDEBAR_WIDTH, width),
            );
          return { sidebarWidthsByProject: widths };
        });
      },
      lastProjectFolder: null,

      setLastProjectFolder: (path) => set({ lastProjectFolder: path }),

      addRecentProject: (path) => {
        const name = path.split(/[/\\]/).pop() || path;
        set((state) => {
          const existing = state.recentProjects.find((p) => p.path === path);
          const filtered = state.recentProjects.filter((p) => p.path !== path);
          return {
            recentProjects: [
              {
                path,
                name,
                lastOpened: Date.now(),
                lastActiveFile: existing?.lastActiveFile,
              },
              ...filtered,
            ].slice(0, MAX_RECENT),
          };
        });
      },

      removeRecentProject: (path) => {
        set((state) => ({
          recentProjects: state.recentProjects.filter((p) => p.path !== path),
        }));
      },

      setRecentProjectLastActiveFile: (path, fileId) => {
        set((state) => ({
          recentProjects: state.recentProjects.map((project) =>
            project.path === path
              ? { ...project, lastActiveFile: fileId }
              : project,
          ),
        }));
      },
    }),
    {
      name: "catalex-projects",
    },
  ),
);

synchronizePersistedStore(useProjectStore);
