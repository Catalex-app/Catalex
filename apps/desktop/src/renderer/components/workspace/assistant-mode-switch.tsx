import { ButtonGroup } from "@/components/ui/button-group";
import { cn } from "@/lib/utils";

import { WORKSPACE_MODES } from "@/lib/ui-theme";
import type { WorkspaceMode } from "@/lib/workspace-mode";

export type WorkspaceAssistantMode = WorkspaceMode;

export function AssistantModeSwitch({
  assistantMode,
  onAssistantModeChange,
}: {
  assistantMode: WorkspaceAssistantMode;
  onAssistantModeChange?: (mode: WorkspaceAssistantMode) => void;
}) {
  return (
    <ButtonGroup
      role="tablist"
      aria-label="Workspace assistant mode"
      data-active-mode={assistantMode}
      className="assistant-mode-switch grid w-full grid-cols-2"
    >
      {WORKSPACE_MODES.map((option) => {
        const isActive = assistantMode === option.id;

        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-assistant-mode-option={option.id}
            className={cn(
              "assistant-mode-tab flex h-7 w-full items-center justify-center rounded-md px-3 font-medium text-xs",
              isActive
                ? `assistant-mode-tab--${option.id} bg-background text-foreground shadow-sm`
                : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
            )}
            onClick={() => onAssistantModeChange?.(option.id)}
          >
            <span>{option.label}</span>
          </button>
        );
      })}
    </ButtonGroup>
  );
}
