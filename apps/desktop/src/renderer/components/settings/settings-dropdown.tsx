import { type LucideIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Hint } from "@/components/ui/tooltip";
import type {
  EditorColorScheme,
  SolarModeLevel,
} from "@/stores/settings-store";
import {
  applySolarModeLevel,
  broadcastSolarModePreview,
} from "./solar-mode-effect";

export const EDITOR_COLOR_SCHEME_OPTIONS: Array<{
  value: EditorColorScheme;
  label: string;
}> = [
  { value: "default", label: "Default" },
  { value: "ocean", label: "Ocean" },
  { value: "forest", label: "Forest" },
  { value: "sunset", label: "Sunset" },
  { value: "mono", label: "Mono" },
];

export const SOLAR_MODE_LABELS: Record<SolarModeLevel, string> = {
  0: "Off",
  1: "Low",
  2: "Med",
  3: "High",
  4: "Max",
};

export const SOLAR_MODE_OPTIONS: Array<{
  value: SolarModeLevel;
  label: string;
}> = [
  { value: 0, label: SOLAR_MODE_LABELS[0] },
  { value: 1, label: SOLAR_MODE_LABELS[1] },
  { value: 2, label: SOLAR_MODE_LABELS[2] },
  { value: 3, label: SOLAR_MODE_LABELS[3] },
  { value: 4, label: SOLAR_MODE_LABELS[4] },
];

export const SETTINGS_DROPDOWN_TRIGGER_CLASS =
  "ml-auto h-8 w-auto min-w-0 max-w-full justify-end rounded-lg border-transparent bg-transparent px-2 font-mono font-normal text-foreground shadow-none hover:bg-background/70 dark:bg-transparent dark:hover:bg-muted/55";

export function SettingsDropdown<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  placeholder,
  onRemoveOption,
  renderIcon,
}: {
  renderIcon?: (value: T) => ReactNode;
  ariaLabel?: string;
  placeholder?: string;
  onRemoveOption?: (value: T) => void;
  disabled?: boolean;
  value: T;
  options: Array<{
    value: T;
    label: string;
    description?: string;
    icon?: LucideIcon;
    labelClassName?: string;
    removable?: boolean;
  }>;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((option) => option.value === value);
  const SelectedIcon = selectedOption?.icon;
  const remove = (option: T) => {
    onRemoveOption?.(option);
    setOpen(false);
  };

  return (
    <Select
      open={open}
      onOpenChange={setOpen}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      disabled={disabled}
    >
      <Hint
        content={
          selectedOption?.description ? (
            open ? null : (
              selectedOption.description
            )
          ) : selectedOption ? (
            <span className="break-all font-mono">{selectedOption.label}</span>
          ) : null
        }
      >
        <SelectTrigger
          size="sm"
          className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
          aria-label={ariaLabel}
        >
          {selectedOption ? (
            <span className="flex min-w-0 items-center gap-1.5">
              {renderIcon ? (
                renderIcon(selectedOption.value)
              ) : SelectedIcon ? (
                <SelectedIcon
                  className={cn(
                    "size-3.5 shrink-0",
                    selectedOption.labelClassName,
                  )}
                />
              ) : null}
              <span className={cn("truncate", selectedOption.labelClassName)}>
                {selectedOption.label}
              </span>
            </span>
          ) : (
            placeholder
          )}
        </SelectTrigger>
      </Hint>
      <SelectContent
        position="popper"
        align="end"
        className="max-w-(--radix-select-content-available-width) rounded-xl"
      >
        {options.map((option) => {
          const OptionIcon = option.icon;
          const removable = option.removable && !!onRemoveOption;
          const item = (
            <SelectItem
              className={cn(
                "justify-start rounded-lg [&>span:last-child]:min-w-0",
                removable &&
                  "group-hover/option:[&>[data-slot=select-item-indicator]]:opacity-0",
              )}
              value={option.value}
              textValue={option.label}
              aria-keyshortcuts={removable ? "Delete" : undefined}
              onKeyDown={(event) => {
                if (removable && event.key === "Delete") {
                  event.preventDefault();
                  event.stopPropagation();
                  remove(option.value);
                }
              }}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {renderIcon ? (
                  renderIcon(option.value)
                ) : OptionIcon ? (
                  <OptionIcon
                    className={cn("size-3.5 shrink-0", option.labelClassName)}
                  />
                ) : null}
                <span
                  className={cn(
                    "min-w-0 whitespace-normal break-all font-mono",
                    option.labelClassName,
                  )}
                >
                  {option.label}
                </span>
              </span>
            </SelectItem>
          );
          return (
            <div key={option.value} className="group/option relative">
              {option.description ? (
                <Hint content={option.description} side="left">
                  {item}
                </Hint>
              ) : (
                item
              )}
              {removable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  tabIndex={-1}
                  className="pointer-events-none absolute top-1/2 right-0.75 size-6 -translate-y-1/2 rounded-md text-muted-foreground opacity-0 group-hover/option:pointer-events-auto group-hover/option:opacity-100"
                  aria-label={`Remove ${option.label} from list`}
                  title="Remove from list (Delete)"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(option.value);
                  }}
                >
                  <XIcon className="size-3.5" />
                </Button>
              )}
            </div>
          );
        })}
      </SelectContent>
    </Select>
  );
}

export function SolarizeDropdown({
  value,
  onValueChange,
}: {
  value: SolarModeLevel;
  onValueChange: (value: SolarModeLevel) => void;
}) {
  const previewSolarModeLevel = (level: SolarModeLevel) => {
    applySolarModeLevel(level);
    broadcastSolarModePreview(level);
  };

  return (
    <Select
      value={String(value)}
      onOpenChange={(open) => {
        if (!open) previewSolarModeLevel(value);
      }}
      onValueChange={(next) => onValueChange(Number(next) as SolarModeLevel)}
    >
      <SelectTrigger
        size="sm"
        className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
        aria-label="Solarize"
      >
        <span>{SOLAR_MODE_LABELS[value]}</span>
      </SelectTrigger>
      <SelectContent position="popper" align="end" className="rounded-xl">
        {SOLAR_MODE_OPTIONS.map((option) => (
          <SelectItem
            className="justify-start rounded-lg"
            key={option.value}
            onMouseEnter={() => previewSolarModeLevel(option.value)}
            onMouseLeave={() => previewSolarModeLevel(value)}
            value={String(option.value)}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
