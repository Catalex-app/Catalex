import { create } from "zustand";
import { persist } from "zustand/middleware";
import { synchronizePersistedStore } from "@/lib/persisted-store-sync";

interface RecentProject {
  path: string;
  name: string;
  lastOpened: number;
  lastActiveFile?: string;
}

interface ProjectState {
  recentProjects: RecentProject[];
  sidebarWidthsByProject: Record<string, number>;
  setProjectSidebarWidth: (path: string, width: number | null) => void;
  lastProjectFolder: string | null;
  addRecentProject: (path: string) => void;
  removeRecentProject: (path: string) => void;
  setRecentProjectLastActiveFile: (path: string, fileId: string) => void;
  setLastProjectFolder: (path: string) => void;
}

const MAX_RECENT = 10;

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
      recentProjects: [],
      sidebarWidthsByProject: {},
      setProjectSidebarWidth: (path, width) => {
        if (width !== null && !Number.isFinite(width)) return;
        set((state) => {
          const widths = { ...state.sidebarWidthsByProject };
          if (width === null) delete widths[path];
          else widths[path] = Math.min(420, Math.max(240, width));
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
