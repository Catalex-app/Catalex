import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "@/stores/project-store";

describe("useProjectStore", () => {
  beforeEach(() => {
    // Reset the store between tests
    useProjectStore.setState({
      recentProjects: [],
      sidebarWidthsByProject: {},
      lastProjectFolder: null,
    });
  });

  it("persists sidebar widths per project and resets only the requested project", async () => {
    const store = useProjectStore.getState();
    store.setProjectSidebarWidth("/a", 210);
    store.setProjectSidebarWidth("/b", 380);
    const saved = localStorage.getItem("catalex-projects")!;
    useProjectStore.setState({ sidebarWidthsByProject: {} }, false);
    // Rehydrate the actual persisted snapshot as a fresh window would.
    localStorage.setItem("catalex-projects", saved);
    await useProjectStore.persist.rehydrate();
    expect(useProjectStore.getState().sidebarWidthsByProject).toEqual({
      "/a": 210,
      "/b": 380,
    });
    store.setProjectSidebarWidth("/a", null);
    expect(useProjectStore.getState().sidebarWidthsByProject).toEqual({
      "/b": 380,
    });
    store.setProjectSidebarWidth("/b", Number.NaN);
    expect(useProjectStore.getState().sidebarWidthsByProject["/b"]).toBe(380);
    store.setProjectSidebarWidth("/b", 1000);
    expect(useProjectStore.getState().sidebarWidthsByProject["/b"]).toBe(420);
    store.setProjectSidebarWidth("/b", 100);
    expect(useProjectStore.getState().sidebarWidthsByProject["/b"]).toBe(200);
  });

  describe("addRecentProject", () => {
    it("adds a project with extracted name", () => {
      useProjectStore.getState().addRecentProject("/Users/dev/my-thesis");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(1);
      expect(recentProjects[0].path).toBe("/Users/dev/my-thesis");
      expect(recentProjects[0].name).toBe("my-thesis");
    });

    it("moves duplicate to front and deduplicates", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("/a");
      store.addRecentProject("/b");
      store.addRecentProject("/a");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(2);
      expect(recentProjects[0].path).toBe("/a");
      expect(recentProjects[1].path).toBe("/b");
    });

    it("preserves lastActiveFile when re-adding an existing project", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("/a");
      store.setRecentProjectLastActiveFile("/a", "src/main.tex");
      store.addRecentProject("/a");
      expect(useProjectStore.getState().recentProjects[0].lastActiveFile).toBe(
        "src/main.tex",
      );
    });

    it("limits to MAX_RECENT (10) entries", () => {
      const store = useProjectStore.getState();
      for (let i = 0; i < 12; i++) {
        store.addRecentProject(`/project-${i}`);
      }
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(10);
      // Most recent should be first
      expect(recentProjects[0].path).toBe("/project-11");
    });

    it("extracts name from path correctly", () => {
      useProjectStore.getState().addRecentProject("/a/b/c/deep-folder");
      expect(useProjectStore.getState().recentProjects[0].name).toBe(
        "deep-folder",
      );
    });

    it("uses full path as name if no segments", () => {
      useProjectStore.getState().addRecentProject("standalone");
      expect(useProjectStore.getState().recentProjects[0].name).toBe(
        "standalone",
      );
    });
  });

  describe("removeRecentProject", () => {
    it("removes a project by path", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("/a");
      store.addRecentProject("/b");
      store.removeRecentProject("/a");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(1);
      expect(recentProjects[0].path).toBe("/b");
    });
  });

  describe("setRecentProjectLastActiveFile", () => {
    it("updates only the matching project", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("/a");
      store.addRecentProject("/b");
      store.setRecentProjectLastActiveFile("/b", "notes.tex");
      const { recentProjects } = useProjectStore.getState();
      const a = recentProjects.find((p) => p.path === "/a");
      const b = recentProjects.find((p) => p.path === "/b");
      expect(a?.lastActiveFile).toBeUndefined();
      expect(b?.lastActiveFile).toBe("notes.tex");
    });
  });
});
