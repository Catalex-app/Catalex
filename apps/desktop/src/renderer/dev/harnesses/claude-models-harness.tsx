import { SolarModeEffect } from "@/components/settings/solar-mode-effect";
import { useEffect, useState } from "react";
import { ThemeProvider } from "next-themes";
import { ChatComposer } from "@/components/agent-chat/chat-composer";
import { SettingsWindow } from "@/components/settings/settings-window";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import type { ClaudeModelInfo } from "@/lib/claude-models";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

// Exercise both older CLI descriptions and newer resolvedModel metadata.
const catalogue: ClaudeModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Sonnet 4.6 · Efficient for routine tasks",
    supportedEffortLevels: ["low", "medium", "high", "max"],
  },
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: "Sonnet 4.6 · Efficient for routine tasks",
    supportedEffortLevels: ["low", "medium", "high", "max"],
  },
  {
    value: "claude-fable-5[1m]",
    displayName: "Fable",
    description:
      "Fable 5 · Most capable for your hardest and longest-running tasks",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "opus",
    displayName: "Opus",
    description: "Best for everyday, complex tasks",
    resolvedModel: "claude-opus-4-8",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
  {
    value: "future-model",
    displayName: "Future Model 7",
    description: "A newly discovered model outside the original three families",
    resolvedModel: "vendor/future-model-7",
    supportsEffort: false,
  },
];

let failNextDiscovery = false;
let initialized = false;
function initialize() {
  if (initialized) return;
  initialized = true;
  ensureDesktopBrowserMocks();
  // Opt-in preview fixture: consume the flag so deleting the row survives reload.
  const previewUrl = new URL(window.location.href);
  if (previewUrl.searchParams.get("dummyModel") === "1") {
    useSettingsStore.getState().addCustomModel({
      provider: "codex",
      id: "gpt-ui-demo",
      displayName: "GPT Demo (UI test)",
      effort: "medium",
    });
    previewUrl.searchParams.delete("dummyModel");
    window.history.replaceState(null, "", previewUrl);
  }
  const internals = (window as unknown as { __TAURI_INTERNALS__: unknown })
    .__TAURI_INTERNALS__ as {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const invoke = internals.invoke;
  const usageRequests: string[] = [];
  (
    window as unknown as { subscriptionUsageRequests: string[] }
  ).subscriptionUsageRequests = usageRequests;
  internals.invoke = async (cmd, args) => {
    if (
      cmd === "read_claude_subscription_usage" ||
      cmd === "read_codex_subscription_usage"
    ) {
      usageRequests.push(cmd);
      const scenario = new URLSearchParams(location.search).get("usage");
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          scenario === "slow" && cmd.includes("claude") ? 1800 : 150,
        ),
      );
      if (scenario === "error") throw new Error("Usage request failed");
      if (scenario === "unavailable") return {};
      if (cmd.includes("codex"))
        return {
          rateLimits: {
            primary: null,
            secondary: {
              usedPercent: 32,
              windowDurationMins: 10080,
              resetsAt: 1800000000,
            },
          },
        };
      return {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 18, resets_at: "2027-01-15T12:00:00Z" },
          seven_day: { utilization: 47, resets_at: "2027-01-20T12:00:00Z" },
        },
      };
    }
    if (cmd === "verify_claude_model" || cmd === "verify_codex_model") {
      const id = String(args?.modelId);
      await new Promise((resolve) =>
        setTimeout(resolve, id === "slow-model" ? 1000 : 150),
      );
      if (id === "invalid-model")
        throw new Error("This model is not available for your account.");
      return {
        id,
        displayName: id === "gpt-custom-test" ? "GPT Custom Legacy" : undefined,
      };
    }
    if (cmd === "plugin:dialog|open") {
      const options = args?.options as
        | { directory?: boolean; title?: string }
        | undefined;
      const selected = (window as Window & { __piPickerResult?: string | null })
        .__piPickerResult;
      if (selected !== undefined) return selected;
      return options?.directory ? "/mock/custom config" : "/mock/custom bin/pi";
    }
    if (cmd === "check_pi_status") {
      const config = args?.piConfig as
        | { binaryPath?: string; configDirectory?: string }
        | undefined;
      return {
        installed: true,
        version: "1.2.0",
        binary_path: config?.binaryPath || "/mock/bin/pi",
        config_directory: config?.configDirectory || "/mock/home/.pi/agent",
        error:
          config?.binaryPath === "/missing/pi"
            ? "Pi executable not found. Choose the Pi executable file."
            : null,
      };
    }
    if (cmd === "list_pi_models")
      return [
        {
          id: "reasoning-model",
          provider: "provider-a",
          name: "Reasoning model",
          reasoning: true,
          thinkingLevelMap: { off: null, minimal: null },
          isDefault: true,
        },
        {
          id: "reasoning-model",
          provider: "provider-b",
          name: "Same model, other provider",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            xhigh: "xhigh",
            max: "max",
          },
        },
        {
          id: "fast-model",
          provider: "provider-a",
          name: "Fast model",
          reasoning: false,
        },
      ];
    if (cmd === "check_claude_status")
      return { installed: true, authenticated: true, version: "harness" };
    if (cmd === "check_codex_status")
      return { installed: true, authenticated: true, version: "harness" };
    if (cmd === "list_codex_models")
      return [
        {
          model: "gpt-5.4",
          display_name: "GPT-5.4",
          description: "Discovered Codex model",
          supported_reasoning_efforts: [
            { value: "medium", description: "Balanced" },
            { value: "high", description: "High" },
          ],
          default_reasoning_effort: "medium",
          is_default: true,
        },
      ];
    if (cmd === "open_settings_window") {
      window.history.replaceState(
        null,
        "",
        `/?debug=claude-models&section=${args?.section ?? "appearance"}&provider=${args?.provider ?? "codex"}`,
      );
      window.dispatchEvent(new Event("harness-open-settings"));
      return;
    }
    if (cmd === "list_claude_models") {
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (failNextDiscovery) {
        failNextDiscovery = false;
        throw new Error(
          "Claude CLI could not load models. Retry to reconnect.",
        );
      }
      return catalogue;
    }
    if (cmd === "slash_commands_list" || cmd === "list_slash_commands")
      return args?.provider === "pi"
        ? [
            {
              id: "pi-skill",
              name: "Pi fixture",
              full_command: "/pi-fixture",
              description: "Pi skill fixture",
              content: "Skill text",
              scope: "skill",
              file_path: "/mock/.pi/agent/skills/pi-fixture/SKILL.md",
              accepts_arguments: true,
            },
          ]
        : [];
    return invoke(cmd, args);
  };
  useAgentChatStore.setState({
    selectedProvider: "claude",
    tabs: useAgentChatStore
      .getState()
      .tabs.map((tab) => ({ ...tab, provider: "claude" })),
    selectedClaudeModel: "opus",
    effortLevel: "medium",
  });
}

export function ClaudeModelsHarness() {
  initialize();
  const [settings, setSettings] = useState(
    new URLSearchParams(window.location.search).has("section"),
  );
  useEffect(() => {
    const openSettings = () => setSettings(true);
    window.addEventListener("harness-open-settings", openSettings);
    return () =>
      window.removeEventListener("harness-open-settings", openSettings);
  }, []);
  const piSelected = useAgentChatStore((state) => state.selectedPiModel);
  const piEffort = useAgentChatStore(
    (state) => state.selectedPiReasoningEffort,
  );
  const codexSelected = useAgentChatStore((state) => state.selectedCodexModel);
  const selected = useAgentChatStore((state) => state.selectedClaudeModel);
  const effort = useAgentChatStore((state) => state.effortLevel);
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <SolarModeEffect />
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex shrink-0 flex-wrap items-center gap-4 border-b p-4 text-sm">
          <button type="button" onClick={() => setSettings(!settings)}>
            {settings ? "Show chat" : "Show settings"}
          </button>
          <button
            type="button"
            onClick={() => {
              failNextDiscovery = true;
              void useClaudeSetupStore.getState().refreshModels();
            }}
          >
            Simulate discovery failure
          </button>
          <button
            type="button"
            onClick={() =>
              useAgentChatStore
                .getState()
                .setSelectedClaudeModel("unavailable-saved-model")
            }
          >
            Select unavailable saved model
          </button>
          <output data-testid="claude-model-selection">
            {selected} / {effort} / {codexSelected} / {piSelected} / {piEffort}
          </output>
          <button
            type="button"
            onClick={() => {
              const store = useAgentChatStore.getState();
              const tabId = store.activeTabId;
              store._setStreaming(tabId, true);
              store._recordContextUsage(tabId, "claude", {
                type: "assistant",
                message: {
                  model: "claude-opus-4-8",
                  usage: {
                    input_tokens: 12000,
                    cache_read_input_tokens: 40000,
                    output_tokens: 2000,
                  },
                },
              });
              store._recordContextUsage(tabId, "claude", {
                type: "result",
                modelUsage: { "claude-opus-4-8": { contextWindow: 200000 } },
              });
              store._setStreaming(tabId, false);
            }}
          >
            Simulate context response
          </button>
        </div>
        {settings ? (
          <div className="min-h-0 flex-1">
            <SettingsWindow />
          </div>
        ) : (
          <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-end pb-12">
            <ChatComposer isExpanded />
          </main>
        )}
      </div>
    </ThemeProvider>
  );
}
