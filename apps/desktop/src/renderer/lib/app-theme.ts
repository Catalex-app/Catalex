import { useTheme } from "next-themes";
import { createLogger } from "./debug/logger";
import { hostInvoke } from "./desktop/bridge";

export const DEFAULT_APP_THEME = "light";

const log = createLogger("app-theme");

export function syncNativeTheme(theme: string) {
  if (!window.catalex) return;
  void hostInvoke("desktop:appearance:setThemeSource", { theme }).catch(
    (error) => log.error("Failed to update native appearance", String(error)),
  );
}

export function useAppTheme() {
  const { theme, setTheme } = useTheme();
  return {
    theme,
    setTheme: (value: string) => {
      setTheme(value);
      // Forward the preference itself so Auto releases any native override.
      syncNativeTheme(value);
    },
  };
}
