import { PlusIcon } from "lucide-react";
import { open } from "@/lib/desktop/dialog";
import { usePiSetupStore } from "@/stores/pi-setup-store";
import { useSettingsStore } from "@/stores/settings-store";

export function usePiPathSettings() {
  const binaryPath = useSettingsStore((s) => s.piBinaryPath);
  const configDirectory = useSettingsStore((s) => s.piConfigDirectory);
  const binaryPaths = useSettingsStore((s) => s.piBinaryPaths);
  const configDirectories = useSettingsStore((s) => s.piConfigDirectories);
  const status = usePiSetupStore((s) => s.status);

  return [
    {
      id: "agent-pi-executable",
      title: "Pi executable",
      selected: binaryPath,
      paths: binaryPaths,
      save: useSettingsStore.getState().setPiBinaryPath,
      remove: useSettingsStore.getState().removePiBinaryPath,
      dialogTitle: "Choose Pi executable",
      directory: false,
    },
    {
      id: "agent-pi-config",
      title: "Config folder",
      selected: configDirectory,
      paths: configDirectories,
      save: useSettingsStore.getState().setPiConfigDirectory,
      remove: useSettingsStore.getState().removePiConfigDirectory,
      dialogTitle: "Choose Pi config folder",
      directory: true,
    },
  ].map((field) => ({
    id: field.id,
    title: field.title,
    dropdown: {
      ariaLabel: field.title,
      value: field.selected,
      placeholder:
        status === "checking" && field.paths === null
          ? "Detecting…"
          : "Select…",
      options: [
        ...(field.paths ?? []).map((path) => ({
          value: path,
          label: path,
          removable: true,
        })),
        { value: "__add_pi_path__", label: "Add new", icon: PlusIcon },
      ],
      onRemoveOption: field.remove,
      onChange: async (value: string) => {
        if (value !== "__add_pi_path__") {
          field.save(value);
          return;
        }
        try {
          const selected = await open({
            directory: field.directory,
            multiple: false,
            noResolveAliases: !field.directory,
            title: field.dialogTitle,
            defaultPath: field.selected || undefined,
          });
          if (typeof selected === "string") field.save(selected);
        } catch (error) {
          usePiSetupStore.setState({ error: String(error) });
        }
      },
    },
  }));
}
