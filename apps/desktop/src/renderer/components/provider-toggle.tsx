import { useSettingsStore, type ChatProvider } from "@/stores/settings-store";
import { SettingsRow } from "./settings/settings-layout";
import { SettingsSwitch } from "./settings/settings-switch";

export function ProviderToggle({ provider }: { provider: ChatProvider }) {
  const enabled = useSettingsStore((s) => s.enabledProviders[provider]);
  const setEnabled = useSettingsStore((s) => s.setProviderEnabled);
  const name =
    provider === "claude" ? "Claude Code" : provider === "pi" ? "Pi" : "Codex";
  return (
    <SettingsRow title={`Enable ${name}`}>
      <SettingsSwitch
        label={`Enable ${name}`}
        checked={enabled}
        onCheckedChange={(value) => setEnabled(provider, value)}
      />
    </SettingsRow>
  );
}
