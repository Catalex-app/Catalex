import { useId, useState, type ReactNode } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { ChevronDownIcon } from "lucide-react";
import { Input } from "./input";
import { Popover, PopoverContent } from "./popover";
import { cn } from "@/lib/utils";

export type PickerOption = {
  value: string;
  label: string;
  description?: string;
};

/** Search input and popup shared by conference and project-file selection. */
export function SearchablePicker({
  query,
  onQueryChange,
  value,
  options,
  onSelect,
  label,
  placeholder,
  align = "left",
  disabled = false,
  onOpen,
  status,
  emptyText = "No matches",
  onQueryStart,
  onSubmit,
  hideWhenEmpty = false,
  openOnFocus = true,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  value?: string;
  options: PickerOption[];
  onSelect: (value: string) => void;
  label: string;
  placeholder: string;
  align?: "left" | "right";
  disabled?: boolean;
  onOpen?: () => void;
  status?: ReactNode;
  emptyText?: string;
  onQueryStart?: () => void;
  onSubmit?: () => void;
  hideWhenEmpty?: boolean;
  openOnFocus?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const popupOpen = open && !disabled && (!hideWhenEmpty || options.length > 0);
  const show = () => {
    if (!disabled) {
      setOpen(true);
      onOpen?.();
    }
  };
  const select = (value: string) => {
    onSelect(value);
    setOpen(false);
    setActive(-1);
  };
  return (
    <Popover open={popupOpen} onOpenChange={setOpen}>
      <PopoverPrimitive.Anchor asChild>
        <div className="relative w-full">
          <Input
            role="combobox"
            aria-label={label}
            aria-expanded={popupOpen}
            aria-controls={id}
            aria-autocomplete="list"
            aria-activedescendant={
              popupOpen && active >= 0 && options[active]
                ? `${id}-${active}`
                : undefined
            }
            disabled={disabled}
            value={query}
            placeholder={placeholder}
            className={cn(
              "h-8 bg-background pr-8 pl-2 text-sm",
              align === "right" ? "text-right" : "text-left",
            )}
            onFocus={openOnFocus ? show : undefined}
            onClick={show}
            onChange={(event) => {
              onQueryStart?.();
              onQueryChange(event.target.value);
              setActive(-1);
              show();
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                show();
                setActive((previous) =>
                  options.length
                    ? (previous +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        options.length) %
                      options.length
                    : -1,
                );
              } else if (
                event.key === "Enter" &&
                popupOpen &&
                options[active]
              ) {
                event.preventDefault();
                select(options[active].value);
              } else if (event.key === "Enter" && onSubmit) {
                event.preventDefault();
                onSubmit();
                setOpen(false);
              } else if (event.key === "Escape" && popupOpen) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              } else if (event.key === "Tab") setOpen(false);
            }}
          />
          <button
            type="button"
            aria-label={`Show ${label}`}
            disabled={disabled}
            className="absolute inset-y-0 right-1 flex w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground disabled:opacity-50"
            onMouseDown={(event) => event.preventDefault()}
            onClick={show}
          >
            <ChevronDownIcon className="size-4" />
          </button>
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverContent
        role="presentation"
        align={align === "left" ? "start" : "end"}
        className="app-scrollbar max-h-64 w-[var(--radix-popover-trigger-width)] min-w-64 overflow-y-auto"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if ((event.target as HTMLElement).closest?.('[role="combobox"]'))
            event.preventDefault();
        }}
      >
        {status ?? (
          <div role="listbox" id={id} aria-label={label}>
            {options.length ? (
              options.map((option, index) => (
                <button
                  key={option.value}
                  id={`${id}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={value === option.value}
                  className={cn(
                    "flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 transition-colors hover:bg-muted/70",
                    align === "right"
                      ? "items-end text-right"
                      : "items-start text-left",
                    (active === index || value === option.value) && "bg-muted",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(option.value)}
                >
                  <span className="w-full truncate font-medium text-popover-foreground text-sm">
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="w-full truncate text-muted-foreground text-xs">
                      {option.description}
                    </span>
                  )}
                </button>
              ))
            ) : (
              <p className="px-3 py-2 text-muted-foreground text-xs">
                {emptyText}
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
