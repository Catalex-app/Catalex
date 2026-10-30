import { useEffect } from "react";
import { invoke } from "@/lib/desktop/core";
import {
  resetAppZoom,
  shouldHandleAppZoomShortcut,
  zoomInApp,
  zoomOutApp,
} from "@/lib/app-zoom";
import {
  getKeyboardShortcutActionForEvent,
  resolveKeyboardShortcut,
  matchesKeyboardShortcut,
} from "@/lib/keyboard-shortcuts";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";

export function useAppZoomShortcuts() {
  const keyboardShortcutOverrides = useSettingsStore(
    (state) => state.keyboardShortcutOverrides,
  );

  useEffect(() => {
    const handleZoomKeyDown = (e: KeyboardEvent) => {
      const zoomAction = (["zoom-in", "zoom-out", "zoom-reset"] as const).find(
        (actionId) =>
          matchesKeyboardShortcut(
            e,
            resolveKeyboardShortcut(keyboardShortcutOverrides, actionId),
          ),
      );
      if (!zoomAction || !shouldHandleAppZoomShortcut(e.target)) {
        return;
      }

      e.preventDefault();

      if (zoomAction === "zoom-in") {
        zoomInApp().catch(console.error);
      } else if (zoomAction === "zoom-out") {
        zoomOutApp().catch(console.error);
      } else {
        resetAppZoom().catch(console.error);
      }
    };

    document.addEventListener("keydown", handleZoomKeyDown, true);
    return () =>
      document.removeEventListener("keydown", handleZoomKeyDown, true);
  }, [keyboardShortcutOverrides]);
}

export function useKeyboardShortcuts() {
  useAppZoomShortcuts();
  const keyboardShortcutOverrides = useSettingsStore(
    (state) => state.keyboardShortcutOverrides,
  );
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const action = getKeyboardShortcutActionForEvent(
        e,
        keyboardShortcutOverrides,
      );
      if (!action) return;

      if (action === "save-file") {
        e.preventDefault();
        const state = useDocumentStore.getState();
        state.setIsSaving(true);
        state.saveCurrentFile().finally(() => {
          setTimeout(() => state.setIsSaving(false), 500);
        });
        return;
      }

      if (action === "new-window") {
        e.preventDefault();
        invoke("create_new_window").catch(console.error);
        return;
      }

      if (action === "open-settings") {
        e.preventDefault();
        invoke("open_settings_window").catch(console.error);
        return;
      }

      if (action === "toggle-debug-panel") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("toggle-debug-panel"));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [keyboardShortcutOverrides]);
}
