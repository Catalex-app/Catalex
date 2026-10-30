// Test-only fixtures go through the actual Rust PoloDB store. No fixture IPC or
// importer is included in the production service.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
let executable;
async function fixtureExecutable() {
  if (process.env.CATALEX_COMMENT_FIXTURE)
    return process.env.CATALEX_COMMENT_FIXTURE;
  if (executable) return executable;
  const directory = fileURLToPath(
    new URL("../../backend/target/debug/deps/", import.meta.url),
  );
  const candidates = [];
  for (const name of await fs.readdir(directory)) {
    if (!/^catalex_desktop_lib-[a-f0-9]+(?:\.exe)?$/.test(name)) continue;
    const file = path.join(directory, name);
    const stat = await fs.stat(file);
    if (stat.isFile()) candidates.push({ file, modified: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.modified - a.modified);
  executable = candidates[0]?.file;
  if (!executable)
    throw new Error(
      "Build native Rust tests before running comment fixtures (pnpm build:native --test).",
    );
  return executable;
}
async function fixture(mode, file, value) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "catalex-comment-fixture-"),
  );
  const io = path.join(temporary, "snapshot.json");
  try {
    if (mode === "write") await fs.writeFile(io, value.toString());
    await exec(
      await fixtureExecutable(),
      [
        "--ignored",
        "--exact",
        "comments::store::tests::fixture_bridge",
        "--nocapture",
      ],
      {
        env: {
          ...process.env,
          CATALEX_FIXTURE_MODE: mode,
          CATALEX_FIXTURE_PATH: file,
          CATALEX_FIXTURE_IO: io,
        },
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      },
    );
    return mode === "read" ? await fs.readFile(io, "utf8") : undefined;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
export function readCommentFixture(file) {
  return fixture("read", file);
}
export function writeCommentFixture(file, raw) {
  return fixture("write", file, raw);
}
