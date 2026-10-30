import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileAccess, filesystemCommand, isWithin } from "./file-access";

describe("desktop filesystem access", () => {
  let directory: string;
  let project: string;
  let outside: string;
  let access: FileAccess;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-files-test-"));
    project = path.join(directory, "project");
    outside = path.join(directory, "outside");
    await Promise.all([fs.mkdir(project), fs.mkdir(outside)]);
    access = new FileAccess();
    await access.grant(project);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("rejects relative paths, sibling prefix matches and parent traversal", async () => {
    expect(isWithin(project, `${project}-backup`)).toBe(false);
    await expect(access.check("main.tex")).rejects.toThrow("absolute");
    await expect(access.check(`${project}-backup/main.tex`)).rejects.toThrow(
      "granted",
    );
    await expect(
      access.check(path.join(project, "..", "outside", "file")),
    ).rejects.toThrow("granted");
    await expect(access.check(`${project}\0main.tex`)).rejects.toThrow(
      "absolute",
    );
  });

  it("allows creation of nested project paths and round-trips text and bytes", async () => {
    const folder = path.join(project, "figures", "generated");
    const file = path.join(folder, "example.bin");
    await filesystemCommand(access, "mkdir", {
      path: folder,
      options: { recursive: true },
    });
    await filesystemCommand(access, "writeFile", {
      path: file,
      contents: new Uint8Array([0, 127, 255]),
    });
    expect(await filesystemCommand(access, "readFile", { path: file })).toEqual(
      new Uint8Array([0, 127, 255]),
    );
    await filesystemCommand(access, "writeTextFile", {
      path: file,
      contents: "Catalex 测试",
    });
    expect(
      await filesystemCommand(access, "readTextFile", { path: file }),
    ).toBe("Catalex 测试");
    expect(
      await filesystemCommand(access, "stat", { path: file }),
    ).toMatchObject({
      isFile: true,
      isDirectory: false,
      isSymlink: false,
      mtime: expect.any(Number),
    });
    expect(
      await filesystemCommand(access, "readDir", { path: folder }),
    ).toEqual([
      {
        name: "example.bin",
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      },
    ]);
    expect(
      await filesystemCommand(access, "exists", {
        path: path.join(folder, "missing"),
      }),
    ).toBe(false);
  });

  it("checks both source and destination before copying or renaming", async () => {
    const insideFile = path.join(project, "main.tex");
    const outsideFile = path.join(outside, "secret.tex");
    await fs.writeFile(insideFile, "inside");
    await fs.writeFile(outsideFile, "outside");
    for (const action of ["copyFile", "rename"]) {
      await expect(
        filesystemCommand(access, action, {
          fromPath: outsideFile,
          toPath: insideFile,
        }),
      ).rejects.toThrow("granted");
      await expect(
        filesystemCommand(access, action, {
          fromPath: insideFile,
          toPath: outsideFile,
        }),
      ).rejects.toThrow("granted");
    }
    expect(await fs.readFile(insideFile, "utf8")).toBe("inside");
    expect(await fs.readFile(outsideFile, "utf8")).toBe("outside");
  });

  it("grants an individually selected file without granting its siblings", async () => {
    const selected = path.join(outside, "selected.pdf");
    await fs.writeFile(selected, "PDF");
    await access.grant(selected);
    await expect(access.check(selected)).resolves.toBe(selected);
    await expect(access.check(path.join(outside, "other.pdf"))).rejects.toThrow(
      "granted",
    );
  });

  it("waits for a native drop grant before checking an immediately requested file", async () => {
    const selected = path.join(outside, "dropped.tex");
    let finishGrant!: () => void;
    const pending = new Promise<string>((resolve) => {
      finishGrant = () => resolve(selected);
    });
    vi.spyOn(fs, "realpath")
      .mockReturnValueOnce(pending)
      .mockResolvedValue(selected);
    const grant = access.grant(selected);
    let settled = false;
    const checked = access.check(selected).finally(() => {
      settled = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      finishGrant();
    }
    await grant;
    await expect(checked).resolves.toBe(selected);
  });

  it.skipIf(process.platform === "win32")(
    "rejects existing symlinks escaping the project",
    async () => {
      const link = path.join(project, "external");
      await fs.symlink(outside, link);
      await expect(access.check(path.join(link, "new.tex"))).rejects.toThrow(
        "granted",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not follow a dangling symlink when creating a file outside scope",
    async () => {
      const link = path.join(project, "main.tex");
      const target = path.join(outside, "not-created.tex");
      await fs.symlink(target, link);
      await expect(
        filesystemCommand(access, "writeTextFile", {
          path: link,
          contents: "must stay inside",
        }),
      ).rejects.toThrow();
      await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("removes a selected tree only when recursive removal is requested", async () => {
    const folder = path.join(project, "generated");
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "draft.tex"), "draft");
    await expect(
      filesystemCommand(access, "remove", { path: folder }),
    ).rejects.toThrow();
    await filesystemCommand(access, "remove", {
      path: folder,
      options: { recursive: true },
    });
    expect(await filesystemCommand(access, "exists", { path: folder })).toBe(
      false,
    );
  });
});
