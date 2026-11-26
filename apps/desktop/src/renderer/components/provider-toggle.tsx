import {
  AGENT_CLI_PERMISSION_OPTION,
  AGENT_PERMISSION_OPTIONS,
  type ChatProvider,
  useSettingsStore,
} from "@/stores/settings-store";
import type { ComponentProps } from "react";
import { HARNESSES } from "@/lib/agent-harness";
import { SettingsDropdown } from "./settings/settings-dropdown";
import { broadcastSettingsChanged } from "./settings/solar-mode-effect";
import { SettingsRow } from "./settings/settings-layout";
import { SettingsSwitch } from "./settings/settings-switch";

export function ProviderToggle({ provider }: { provider: ChatProvider }) {
  const enabled = useSettingsStore((s) => s.enabledProviders[provider]);
  const setEnabled = useSettingsStore((s) => s.setProviderEnabled);
  const name = HARNESSES[provider].label;
  return (
    <SettingsRow title={`Enable ${name}`}>
      <SettingsSwitch
        label={`Enable ${name}`}
        checked={enabled === true}
        onCheckedChange={(value) => setEnabled(provider, value)}
      />
    </SettingsRow>
  );
}

export function ProviderSettings({
  provider,
  model,
  effort,
  status,
  defaultLabel,
}: {
  provider: ChatProvider;
  model?: ComponentProps<typeof SettingsDropdown<string>>;
  effort?: ComponentProps<typeof SettingsDropdown<string>>;
  status?: string;
  defaultLabel?: string;
}) {
  const settings = useSettingsStore();
  if (!settings.enabledProviders[provider]) return null;
  const title = `Use ${HARNESSES[provider].label} by default`;
  const fallback = (Object.keys(HARNESSES) as ChatProvider[]).find(
    (other) => other !== provider && settings.enabledProviders[other],
  );
  return (
    <>
      {status !== "not-installed" && (
        <SettingsRow id="agent-default-agent" title={title}>
          <SettingsSwitch
            label={defaultLabel ?? title}
            checked={settings.defaultAgent === provider}
            onCheckedChange={(checked) => {
              settings.setDefaultAgent(
                checked ? provider : (fallback ?? provider),
              );
              broadcastSettingsChanged();
            }}
          />
        </SettingsRow>
      )}
      {model && (
        <SettingsRow id={`agent-${provider}-model`} title="Default model">
          <SettingsDropdown ariaLabel="Default model" {...model} />
        </SettingsRow>
      )}
      {effort && (
        <SettingsRow id={`agent-${provider}-level`} title="Thinking level">
          <SettingsDropdown ariaLabel="Thinking level" {...effort} />
        </SettingsRow>
      )}
    </>
  );
}

export function ProviderPermissionSettings({
  provider,
}: {
  provider: ChatProvider;
}) {
  const enabled = useSettingsStore((s) => s.enabledProviders[provider]);
  const permissions = useSettingsStore((s) => s.agentPermissions);
  const setPermission = useSettingsStore((s) => s.setAgentPermission);
  if (!enabled || provider === "pi") return null;
  return (
    <SettingsRow title="Agent permission">
      <SettingsDropdown
        ariaLabel="Agent permission"
        value={
          permissions[provider] ?? (provider === "codex" ? "never" : "auto")
        }
        options={[
          ...AGENT_PERMISSION_OPTIONS[provider],
          AGENT_CLI_PERMISSION_OPTION,
        ]}
        onChange={(value) => {
          setPermission(provider, value);
          broadcastSettingsChanged();
        }}
      />
    </SettingsRow>
  );
}

export function ProviderSetupStatus({
  setup,
}: {
  setup: {
    status: string;
    error: string | null;
    models: readonly unknown[];
    refreshModels: () => Promise<void>;
  };
}) {
  if (
    setup.status === "disabled" ||
    (setup.status === "ready" && setup.models.length)
  )
    return null;
  const error =
    setup.error ??
    (setup.status === "not-installed"
      ? "Install Antigravity CLI in your terminal, then check again."
      : "Could not load models.");
  return (
    <p role="status" className="px-4 pb-3 text-muted-foreground text-xs">
      {setup.status === "checking" ? "Loading models…" : error}{" "}
      {setup.status !== "checking" && (
        <button
          type="button"
          className="underline"
          onClick={() => void setup.refreshModels()}
        >
          Retry
        </button>
      )}
    </p>
  );
}
