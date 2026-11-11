import { useEffect } from "react";
import { getContextMenuCoordinator } from "@/lib/context-menu-coordinator";
import type { ApplicationMenuState, MenuAction } from "../../application-menu";
import { invoke } from "@/lib/desktop/core";
import { shouldHandleAppZoomShortcut } from "@/lib/app-zoom";
import {
  KEYBOARD_SHORTCUT_ACTIONS,
  resolveKeyboardShortcut,
} from "@/lib/keyboard-shortcuts";
import { useSettingsStore } from "@/stores/settings-store";
import {
  getAppMenuItems,
  runMenuAction,
  subscribeAppActions,
} from "./use-app-actions";

export function useApplicationMenu() {
  useEffect(() => {
    if (!window.catalex) return;
    const coordinator = getContextMenuCoordinator(document);
    let disposed = false;
    let queued = false;
    let previous = "";
    const publish = () => {
      if (queued || disposed) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (disposed) return;
        const overrides = useSettingsStore.getState().keyboardShortcutOverrides;
        const state: ApplicationMenuState = {
          items: getAppMenuItems(),
          contextMenuOpen: !coordinator.canOpen(),
          recordingShortcut: !!document.activeElement?.closest(
            "[data-shortcut-action]",
          ),
          shortcuts: Object.fromEntries(
            KEYBOARD_SHORTCUT_ACTIONS.map(({ id }) => [
              id,
              id.startsWith("zoom-") &&
              !shouldHandleAppZoomShortcut(document.activeElement)
                ? null
                : resolveKeyboardShortcut(overrides, id),
            ]),
          ),
        };
        const serialized = JSON.stringify(state);
        if (serialized === previous) return;
        previous = serialized;
        void invoke("desktop:menu:update", { state }).catch(console.error);
      });
    };
    const stop = window.catalex.listen("application-menu", (action) => {
      if (getContextMenuCoordinator(document).canOpen())
        void runMenuAction(action as MenuAction);
    });
    const stopMenus = coordinator.subscribe(publish);
    const stopActions = subscribeAppActions(publish);
    const stopSettings = useSettingsStore.subscribe(publish);
    document.addEventListener("focusin", publish);
    document.addEventListener("focusout", publish);
    publish();
    return () => {
      disposed = true;
      stop();
      stopMenus();
      stopActions();
      stopSettings();
      document.removeEventListener("focusin", publish);
      document.removeEventListener("focusout", publish);
    };
  }, []);
}
