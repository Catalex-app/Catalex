import { expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { storeChatAttachment } from "./chat-attachments";

test("persistent files remain references without creating storage", async () => {
  const source = path.resolve("package.json");
  expect(
    await storeChatAttachment(
      async () => {
        throw new Error("must not copy");
      },
      { sourcePath: source },
    ),
  ).toBe(await fs.realpath(source));
});
test("transient files and clipboard bytes persist outside the project without overwrites", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-test-"));
  try {
    const managed = path.join(root, "managed");
    await fs.mkdir(managed);
    const source = path.join(root, "shot.png");
    await fs.writeFile(source, "image");
    const first = await storeChatAttachment(async () => managed, {
      sourcePath: source,
    });
    const second = await storeChatAttachment(async () => managed, {
      name: "shot.png",
      bytes: [1, 2, 3],
    });
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(managed);
    expect(await fs.readFile(first, "utf8")).toBe("image");
    expect([...(await fs.readFile(second))]).toEqual([1, 2, 3]);
    await expect(
      storeChatAttachment(async () => managed, { bytes: [-1] }),
    ).rejects.toThrow("Invalid attachment");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
