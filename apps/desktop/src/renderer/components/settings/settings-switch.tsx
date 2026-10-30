import { cn } from "@/lib/utils";
type SettingsSwitchProps = {
  checked: boolean;
  size?: "default" | "sm";
} & (
  | { indicatorOnly: true }
  | {
      indicatorOnly?: false;
      label: string;
      onCheckedChange: (checked: boolean) => void;
    }
);

export function SettingsSwitch(props: SettingsSwitchProps) {
  const { checked, size = "default" } = props;
  const indicator = (
    <span
      aria-hidden="true"
      data-slot="settings-switch-track"
      data-sidebar-switch-track={size === "sm" ? "" : undefined}
      data-checked={checked}
      className={cn(
        "relative inline-block shrink-0 rounded-full border transition-colors",
        size === "sm"
          ? cn(
              "h-4 w-7",
              checked
                ? "border-foreground/25 bg-foreground"
                : "border-sidebar-border bg-muted",
            )
          : cn(
              "h-5 w-9",
              checked
                ? "border-foreground bg-foreground"
                : "border-border bg-muted",
            ),
      )}
    >
      <span
        data-sidebar-switch-thumb={size === "sm" ? "" : undefined}
        className={cn(
          "absolute rounded-full transition-transform",
          size === "sm"
            ? cn(
                "top-1/2 left-0.5 size-2.5 -translate-y-1/2 bg-background",
                checked ? "translate-x-3" : "translate-x-0",
              )
            : cn(
                "top-0.5 left-0.5 size-3.5 shadow-sm",
                checked
                  ? "translate-x-4 bg-background"
                  : "translate-x-0 bg-muted-foreground",
              ),
        )}
      />
    </span>
  );
  // Menu rows own their interaction and accessibility; reuse only the visual.
  if (props.indicatorOnly) return indicator;
  const { label, onCheckedChange } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm"
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="text-muted-foreground">{checked ? "On" : "Off"}</span>
      {indicator}
    </button>
  );
}
