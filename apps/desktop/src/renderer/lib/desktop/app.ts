import { hostInvoke } from "./bridge";

export function getVersion(): Promise<string> {
  return hostInvoke("desktop:app:getVersion", undefined, "plugin:app|version");
}
