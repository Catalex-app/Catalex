import { browserHarness, hostInvoke } from "./bridge";

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface FileInfo {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: Date | null;
}

export async function readTextFile(path: string): Promise<string> {
  const value = await hostInvoke<string | number[]>(
    "desktop:fs:readTextFile",
    { path },
    "plugin:fs|read_text_file",
    { path, options: {} },
  );
  return typeof value === "string"
    ? value
    : new TextDecoder().decode(new Uint8Array(value));
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  const harness = !window.catalex && browserHarness();
  if (harness) {
    return harness.invoke(
      "plugin:fs|write_text_file",
      new TextEncoder().encode(contents),
      { headers: { path: encodeURIComponent(path), options: "{}" } },
    ) as Promise<void>;
  }
  return hostInvoke(
    "desktop:fs:writeTextFile",
    { path, contents },
    "plugin:fs|write_text_file",
    { path, contents, options: {} },
  );
}

export async function readFile(path: string): Promise<Uint8Array> {
  const bytes = await hostInvoke<Uint8Array | number[]>(
    "desktop:fs:readFile",
    { path },
    "plugin:fs|read_file",
    { path, options: {} },
  );
  return new Uint8Array(bytes);
}

export function writeFile(path: string, contents: Uint8Array): Promise<void> {
  const harness = !window.catalex && browserHarness();
  if (harness) {
    return harness.invoke("plugin:fs|write_file", contents, {
      headers: { path: encodeURIComponent(path), options: "{}" },
    }) as Promise<void>;
  }
  return hostInvoke(
    "desktop:fs:writeFile",
    { path, contents },
    "plugin:fs|write_file",
    { path, contents, options: {} },
  );
}

export function readDir(path: string): Promise<DirEntry[]> {
  return hostInvoke("desktop:fs:readDir", { path }, "plugin:fs|read_dir", {
    path,
    options: {},
  });
}

export function exists(path: string): Promise<boolean> {
  return hostInvoke("desktop:fs:exists", { path }, "plugin:fs|exists", {
    path,
    options: {},
  });
}

export async function stat(path: string): Promise<FileInfo> {
  const info = await hostInvoke<
    Omit<FileInfo, "mtime"> & { mtime?: number | string | null }
  >("desktop:fs:stat", { path }, "plugin:fs|stat", { path, options: {} });
  return { ...info, mtime: info.mtime == null ? null : new Date(info.mtime) };
}

export function mkdir(
  path: string,
  options?: { recursive?: boolean },
): Promise<void> {
  return hostInvoke("desktop:fs:mkdir", { path, options }, "plugin:fs|mkdir");
}

export function remove(
  path: string,
  options?: { recursive?: boolean },
): Promise<void> {
  return hostInvoke("desktop:fs:remove", { path, options }, "plugin:fs|remove");
}

export function copyFile(fromPath: string, toPath: string): Promise<void> {
  return hostInvoke(
    "desktop:fs:copyFile",
    { fromPath, toPath },
    "plugin:fs|copy_file",
    { fromPath, toPath, options: {} },
  );
}

export function rename(fromPath: string, toPath: string): Promise<void> {
  return hostInvoke(
    "desktop:fs:rename",
    { fromPath, toPath },
    "plugin:fs|rename",
    { oldPath: fromPath, newPath: toPath, options: {} },
  );
}
