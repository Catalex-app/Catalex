import { hostInvoke } from "./bridge";

interface DialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

interface OpenDialogOptions extends DialogOptions {
  directory?: boolean;
  multiple?: boolean;
  noResolveAliases?: boolean;
}

export function open(
  options: OpenDialogOptions & { multiple: true },
): Promise<string[] | null>;
export function open(
  options?: OpenDialogOptions & { multiple?: false },
): Promise<string | null>;
export function open(
  options?: OpenDialogOptions,
): Promise<string | string[] | null> {
  return hostInvoke("desktop:dialog:open", { options }, "plugin:dialog|open");
}

export function save(options?: DialogOptions): Promise<string | null> {
  return hostInvoke("desktop:dialog:save", { options }, "plugin:dialog|save");
}

export function ask(
  message: string,
  options?: {
    title?: string;
    kind?: "info" | "warning" | "error";
    okLabel?: string;
    cancelLabel?: string;
    defaultButton?: "ok" | "cancel";
  },
): Promise<boolean> {
  return hostInvoke(
    "desktop:dialog:ask",
    { message, options },
    "plugin:dialog|ask",
  );
}
