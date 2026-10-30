import { useState } from "react";
import { ConferenceDeadlinePicker } from "@/components/settings/conference-deadline-picker";
import {
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/settings-layout";
import {
  SettingsDropdown,
  CAT_MODE_OPTIONS,
  CAT_STATIC_OPTIONS,
  CAT_TIMEZONE_OPTIONS,
  CAT_COUNTDOWN_OPTIONS,
} from "@/components/settings/settings-window";
import { Input } from "@/components/ui/input";
import { useSettingsStore } from "@/stores/settings-store";

export function OnboardingCatSettings() {
  const s = useSettingsStore();
  const [customText, setCustomText] = useState(s.catCustomText);
  return (
    <div>
      <SettingsGroup>
        <SettingsRow title="Display">
          <SettingsDropdown
            ariaLabel="Cat display"
            value={s.catDisplayMode}
            options={CAT_MODE_OPTIONS}
            onChange={s.setCatDisplayMode}
          />
        </SettingsRow>
        {s.catDisplayMode === "ccfddl" ? (
          <>
            <SettingsRow title="Conference deadline">
              <ConferenceDeadlinePicker />
            </SettingsRow>
            <SettingsRow title="Time zone">
              <SettingsDropdown
                ariaLabel="Cat time zone"
                value={s.catDisplayTimezone}
                options={CAT_TIMEZONE_OPTIONS}
                onChange={s.setCatDisplayTimezone}
              />
            </SettingsRow>
            <SettingsRow title="Countdown">
              <SettingsDropdown
                ariaLabel="Cat countdown"
                value={s.catCountdownPrecision}
                options={CAT_COUNTDOWN_OPTIONS}
                onChange={s.setCatCountdownPrecision}
              />
            </SettingsRow>
          </>
        ) : (
          <>
            <SettingsRow title="Static text">
              <SettingsDropdown
                ariaLabel="Cat’s message"
                value={s.catStaticDisplay}
                options={CAT_STATIC_OPTIONS}
                onChange={s.setCatStaticDisplay}
              />
            </SettingsRow>
            {s.catStaticDisplay === "custom" && (
              <SettingsRow title="Your message">
                <Input
                  aria-label="Your message"
                  maxLength={28}
                  value={customText}
                  onChange={(e) => {
                    setCustomText(e.target.value);
                    s.setCatCustomText(e.target.value);
                  }}
                />
              </SettingsRow>
            )}
          </>
        )}
      </SettingsGroup>
      <p className="mt-5 text-muted-foreground text-sm">
        You can change this anytime in Settings → Cats.
      </p>
    </div>
  );
}
