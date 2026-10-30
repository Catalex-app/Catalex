import { hostInvoke } from "./bridge";

export function relaunch(): Promise<void> {
  return hostInvoke("desktop:process:relaunch");
}
