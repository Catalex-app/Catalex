import { useEffect, useRef, useState } from "react";
import { Hint, TooltipProvider } from "@/components/ui/tooltip";
import { renderDomHint, destroyDomHint } from "@/components/ui/dom-hint";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { useSettingsStore } from "@/stores/settings-store";

export function TooltipHarness() {
  const show = useSettingsStore((s) => s.showTooltips);
  const delay = useSettingsStore((s) => s.tooltipHoverDelay);
  const [clicks, setClicks] = useState(0);
  const [dark, setDark] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const element = host.current;
    renderDomHint(element, "Agent badge", "Created by codex");
    return () => destroyDomHint(element);
  }, []);
  return (
    <TooltipProvider>
      <main
        className="min-h-screen bg-background p-12 text-foreground"
        data-testid="tooltip-harness"
      >
        <h1 className="mb-8 font-semibold text-lg">Tooltip behavior</h1>
        <div className="mb-12 flex gap-4">
          <label>
            <input
              type="checkbox"
              checked={show}
              onChange={(e) =>
                useSettingsStore.getState().setShowTooltips(e.target.checked)
              }
            />{" "}
            Show tooltips
          </label>
          <label>
            <input
              type="checkbox"
              checked={delay}
              onChange={(e) =>
                useSettingsStore
                  .getState()
                  .setTooltipHoverDelay(e.target.checked)
              }
            />{" "}
            Hover delay
          </label>
          <label>
            <input
              type="checkbox"
              checked={dark}
              onChange={(e) => {
                setDark(e.target.checked);
                document.documentElement.classList.toggle(
                  "dark",
                  e.target.checked,
                );
              }}
            />{" "}
            Dark theme
          </label>
        </div>
        <div className="flex items-center gap-8">
          <Hint content="Save changes">
            <Button onClick={() => setClicks(clicks + 1)}>Save</Button>
          </Hint>
          <Hint content="No changes to save">
            <Button disabled>Disabled save</Button>
          </Hint>
          <TooltipIconButton tooltip="New chat">
            <span aria-hidden="true">+</span>
          </TooltipIconButton>
          <Popover>
            <Hint content="Open options">
              <PopoverTrigger asChild>
                <Button>Options</Button>
              </PopoverTrigger>
            </Hint>
            <PopoverContent>
              <p>Options opened</p>
            </PopoverContent>
          </Popover>
          <Hint content="/Users/example/Documents/research/a-very-long-project-name/main.tex">
            <span className="max-w-36 truncate">
              /Users/example/Documents/research/a-very-long-project-name/main.tex
            </span>
          </Hint>
          <span ref={host} />
        </div>
        <p className="mt-8">Saved {clicks} times</p>
      </main>
    </TooltipProvider>
  );
}
