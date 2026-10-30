import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = path.join(root, "packages/document-core");
const output = path.join(
  root,
  "apps/desktop/src/renderer/lib/document-core.generated.ts",
);

export function buildDocumentCore() {
  const inputs = [
    "Cargo.toml",
    "Cargo.lock",
    ...readdirSync(path.join(directory, "src"))
      .sort()
      .map((name) => `src/${name}`),
  ];
  const hash = createHash("sha256").update(
    readFileSync(fileURLToPath(import.meta.url)),
  );
  for (const input of inputs)
    hash.update(input).update(readFileSync(path.join(directory, input)));
  const header = `// Generated document core ${hash.digest("hex")}. Do not edit.\n`;
  try {
    if (readFileSync(output, "utf8").startsWith(header)) return;
  } catch {
    /* First build. */
  }
  const result = spawnSync(
    "cargo",
    [
      "build",
      "--manifest-path",
      path.join(directory, "Cargo.toml"),
      "--target",
      "wasm32-unknown-unknown",
      "--target-dir",
      path.join(directory, "target"),
      "--release",
      "--locked",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      "Document core build failed. Install the Rust target with: rustup target add wasm32-unknown-unknown",
    );
  const bytes = readFileSync(
    path.join(
      directory,
      "target/wasm32-unknown-unknown/release/catalex_document_core.wasm",
    ),
  );
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${header}export const documentCoreWasm = ${JSON.stringify(bytes.toString("base64"))};\n`,
  );
  renameSync(temporary, output);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  buildDocumentCore();
