import { toast } from "sonner";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";
import { useAppActions } from "./use-app-actions";

export async function openRecentProject(path: string) {
  try {
    await useDocumentStore.getState().openProject(path);
    useProjectStore.getState().addRecentProject(path);
  } catch (error) {
    toast.error(String(error instanceof Error ? error.message : error));
  }
}

export function useProjectActions(enabled: boolean) {
  const root = useDocumentStore((s) => s.projectRoot);
  const projects = useProjectStore((s) => s.recentProjects);
  return useAppActions([
    {
      id: "open-recent",
      label: "Open Recent Projects",
      enabled: enabled && projects.length > 0,
      run: () => {},
      menu: { group: "File", section: 1, order: 0 },
      children: projects.map((project) => ({
        id: project.path,
        label: `${project.name} — ${project.path}`,
        run: () => openRecentProject(project.path),
      })),
    },
    {
      id: "close-project",
      label: "Close Project",
      enabled: enabled && !!root,
      run: () => useDocumentStore.getState().closeProject(),
      menu: { group: "File", section: 3, order: 0 },
    },
  ]);
}
