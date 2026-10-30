import { hostInvoke } from "./bridge";

export function open(path: string): Promise<void> {
  return hostInvoke("desktop:shell:open", { path }, "plugin:shell|open");
}
