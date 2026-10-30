import { PRODUCT_NAME } from "../branding";
import fs from "node:fs/promises";
import path from "node:path";

/** Same default home/temp scope as the old app, plus native dialog/drop grants. */
export class FileAccess {
  private roots: string[] = [];
  private pendingGrants = new Set<Promise<void>>();

  grant(value: string): Promise<void> {
    const grant = this.canonical(value).then((canonical) => {
      if (!this.roots.includes(canonical)) this.roots.push(canonical);
    });
    this.pendingGrants.add(grant);
    void grant.finally(() => this.pendingGrants.delete(grant)).catch(() => {});
    return grant;
  }

  async check(value: unknown): Promise<string> {
    if (
      typeof value !== "string" ||
      !path.isAbsolute(value) ||
      value.includes("\0")
    ) {
      throw new Error("An absolute file path is required.");
    }
    // A native drop grants its path just before the renderer starts reading it.
    await Promise.allSettled(this.pendingGrants);
    const canonical = await this.canonical(value);
    if (!this.roots.some((root) => isWithin(root, canonical))) {
      throw new Error(
        "This path has not been granted to " + PRODUCT_NAME + ".",
      );
    }
    return path.resolve(value);
  }

  private async canonical(value: string): Promise<string> {
    const absolute = path.resolve(value);
    try {
      return await fs.realpath(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // realpath also reports ENOENT for dangling symlinks. Resolve their target
      // before checking scope; treating them as ordinary files permits escape.
      const link = await fs
        .lstat(absolute)
        .catch((statError: NodeJS.ErrnoException) => {
          if (statError.code !== "ENOENT") throw statError;
          return null;
        });
      if (link?.isSymbolicLink()) {
        throw new Error("Dangling symbolic links are not supported.");
      }
      const parent = path.dirname(absolute);
      if (parent === absolute) throw error;
      return path.join(await this.canonical(parent), path.basename(absolute));
    }
  }
}

export function isWithin(root: string, file: string) {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function filesystemCommand(
  access: FileAccess,
  action: string,
  args: Record<string, any>,
) {
  if (action === "copyFile" || action === "rename") {
    const from = await access.check(args.fromPath);
    const to = await access.check(args.toPath);
    return action === "copyFile" ? fs.copyFile(from, to) : fs.rename(from, to);
  }
  const file = await access.check(args.path);
  switch (action) {
    case "readTextFile":
      return fs.readFile(file, "utf8");
    case "writeTextFile":
      if (typeof args.contents !== "string")
        throw new Error("Text contents are required.");
      return fs.writeFile(file, args.contents, "utf8");
    case "readFile":
      return new Uint8Array(await fs.readFile(file));
    case "writeFile":
      return fs.writeFile(file, Buffer.from(args.contents));
    case "readDir":
      return (await fs.readdir(file, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      }));
    case "exists":
      try {
        await fs.access(file);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    case "stat": {
      const [stat, link] = await Promise.all([fs.stat(file), fs.lstat(file)]);
      return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymlink: link.isSymbolicLink(),
        size: stat.size,
        mtime: stat.mtimeMs,
      };
    }
    case "mkdir":
      return fs.mkdir(file, { recursive: args.options?.recursive === true });
    case "remove":
      return fs.rm(file, { recursive: args.options?.recursive === true });
    default:
      throw new Error(`Unknown filesystem operation: ${action}`);
  }
}
