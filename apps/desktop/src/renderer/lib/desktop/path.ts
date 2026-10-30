import { hostInvoke } from "./bridge";

export function homeDir(): Promise<string> {
  return hostInvoke(
    "desktop:path:homeDir",
    undefined,
    "plugin:path|resolve_directory",
    { directory: 21 },
  );
}

export function configDir(): Promise<string> {
  return hostInvoke(
    "desktop:path:configDir",
    undefined,
    "plugin:path|resolve_directory",
    { directory: 3 },
  );
}

export function join(...paths: string[]): Promise<string> {
  return hostInvoke("desktop:path:join", { paths }, "plugin:path|join");
}
