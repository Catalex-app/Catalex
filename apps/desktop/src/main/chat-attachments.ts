import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isWithin } from "./file-access";

// Persistent files stay references; transient OS drops and clipboard bytes need
// a durable copy alongside the project's chat data, never in the source tree.
export async function storeChatAttachment(
  directory: () => Promise<string>,
  input: { sourcePath?: string; name?: string; bytes?: number[] },
): Promise<string> {
  if (input.sourcePath) {
    const source = await fs.realpath(input.sourcePath);
    if (!(await fs.stat(source)).isFile())
      throw new Error("Attach a file, not a folder.");
    const temporaryRoot = await fs.realpath(os.tmpdir());
    if (!isWithin(temporaryRoot, source)) return source;
    const target = path.join(
      await directory(),
      `${randomUUID()}-${path.basename(source)}`,
    );
    await fs.copyFile(source, target);
    return target;
  }
  if (
    !Array.isArray(input.bytes) ||
    !input.bytes.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    )
  )
    throw new Error("Invalid attachment data.");
  const name = path.basename((input.name || "image.png").replaceAll("\\", "/"));
  const target = path.join(await directory(), `${randomUUID()}-${name}`);
  await fs.writeFile(target, new Uint8Array(input.bytes), { flag: "wx" });
  return target;
}
