import { useEffect, useState } from "react";
import { invoke } from "@/lib/desktop/core";
import { useProjectStore } from "@/stores/project-store";

export function useProjectOwnership() {
  const recentProjects = useProjectStore((state) => state.recentProjects);
  const [owners, setOwners] = useState<Record<string, string | null>>({});
  useEffect(() => {
    if (!window.catalex) return;
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const next = await invoke<Record<string, string | null>>(
          "desktop:project:owners",
          {
            paths: recentProjects.map((project) => project.path),
          },
        );
        if (!disposed && current === revision) setOwners(next);
      } catch (error) {
        console.error("Could not check open projects", error);
      }
    };
    const unsubscribe = window.catalex.listen(
      "project-ownership-changed",
      () => void refresh(),
    );
    void refresh();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [recentProjects]);
  return owners;
}
