import { useEffect } from "react";
import { type SolarModeLevel, useSettingsStore } from "@/stores/settings-store";

const SETTINGS_CHANNEL = "catalex-settings";

type SettingsChannelMessage =
  | "settings-changed"
  | {
      type: "solar-mode-preview";
      level: SolarModeLevel;
    };

function broadcastSettingsMessage(message: SettingsChannelMessage) {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) return;

  const channel = new BroadcastChannel(SETTINGS_CHANNEL);
  channel.postMessage(message);
  channel.close();
}

export function broadcastSettingsChanged() {
  broadcastSettingsMessage("settings-changed");
}

export function broadcastSolarModePreview(level: SolarModeLevel) {
  broadcastSettingsMessage({
    type: "solar-mode-preview",
    level,
  });
}

export function applySolarModeLevel(level: SolarModeLevel) {
  document.documentElement.classList.toggle("solar-mode", level > 0);
  document.documentElement.style.setProperty(
    "--solar-mode-opacity",
    String(level * 0.04),
  );
}

export function SolarModeEffect() {
  const solarModeLevel = useSettingsStore((s) => s.solarModeLevel);

  useEffect(() => {
    applySolarModeLevel(solarModeLevel);
    return () => {
      document.documentElement.classList.remove("solar-mode");
      document.documentElement.style.removeProperty("--solar-mode-opacity");
    };
  }, [solarModeLevel]);

  useEffect(() => {
    const rehydrateSettings = () => {
      void useSettingsStore.persist.rehydrate();
    };

    const channel =
      "BroadcastChannel" in window
        ? new BroadcastChannel(SETTINGS_CHANNEL)
        : null;
    if (channel) {
      channel.onmessage = (event: MessageEvent<SettingsChannelMessage>) => {
        if (
          typeof event.data === "object" &&
          event.data?.type === "solar-mode-preview"
        ) {
          applySolarModeLevel(event.data.level);
          return;
        }

        rehydrateSettings();
      };
    }

    return () => {
      channel?.close();
    };
  }, []);

  return null;
}
