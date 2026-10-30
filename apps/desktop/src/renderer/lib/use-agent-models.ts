import { usePiSetupStore } from "@/stores/pi-setup-store";
import { useMemo } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { mergeClaudeModels, mergeCodexModels } from "./custom-models";

export function useClaudeModels() {
  const discovered = useClaudeSetupStore((s) => s.models);
  const custom = useSettingsStore((s) => s.customModels);
  return useMemo(
    () => mergeClaudeModels(discovered, custom),
    [discovered, custom],
  );
}

export function useCodexModels() {
  const discovered = useCodexSetupStore((s) => s.models);
  const custom = useSettingsStore((s) => s.customModels);
  return useMemo(
    () => mergeCodexModels(discovered, custom),
    [discovered, custom],
  );
}

export function usePiModels() {
  return usePiSetupStore((s) => s.models);
}
