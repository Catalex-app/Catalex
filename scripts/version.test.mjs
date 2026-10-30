import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./version.mjs", import.meta.url));
const manifests = [
  "package.json",
  "apps/desktop/package.json",
  "apps/desktop-sidecar/package.json",
];
const dependency = `[[package]]
name = "upstream-dependency"
version = "7.8.9"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "unchanged-checksum"
`;

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "catalex-version-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of manifests) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), JSON.stringify({ version: "0.46.2" }));
  }
  const backend = path.join(root, "apps/desktop/backend");
  mkdirSync(backend, { recursive: true });
  writeFileSync(
    path.join(backend, "Cargo.toml"),
    '[package]\nname = "catalex-desktop"\nversion = "0.46.2"\n',
  );
  writeFileSync(
    path.join(backend, "Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "catalex-desktop"\nversion = "0.46.2"\n\n${dependency}`,
  );
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
    });
  return { root, backend, run };
}

test("explicit baseline reset synchronizes manifests and the locked native crate", (t) => {
  const { root, backend, run } = fixture(t);
  const result = run("set", "0.1.0");
  assert.equal(result.status, 0, result.stderr);
  for (const file of manifests)
    assert.equal(
      JSON.parse(readFileSync(path.join(root, file))).version,
      "0.1.0",
    );
  assert.match(
    readFileSync(path.join(backend, "Cargo.toml"), "utf8"),
    /version = "0\.1\.0"/,
  );
  const lock = readFileSync(path.join(backend, "Cargo.lock"), "utf8");
  assert.match(lock, /name = "catalex-desktop"\nversion = "0\.1\.0"/);
  assert.ok(lock.endsWith(dependency));
  assert.equal(run("check").status, 0);
});

test("version check rejects a stale native lockfile before a locked build", (t) => {
  const { backend, run } = fixture(t);
  const lock = path.join(backend, "Cargo.lock");
  writeFileSync(
    lock,
    readFileSync(lock, "utf8").replace(
      'version = "0.46.2"',
      'version = "0.45.0"',
    ),
  );
  const result = run("check");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cargoLock: 0\.45\.0/);
});

test("sync repairs only the root crate version while preserving locked dependencies", (t) => {
  const { root, backend, run } = fixture(t);
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version: "0.1.0-beta.1" }),
  );
  const result = run("sync");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    readFileSync(path.join(backend, "Cargo.lock"), "utf8").endsWith(dependency),
  );
  assert.equal(run("check").status, 0);
});

test("invalid version input does not modify the source manifests or lockfile", (t) => {
  const { root, backend, run } = fixture(t);
  const files = [
    ...manifests.map((name) => path.join(root, name)),
    path.join(backend, "Cargo.toml"),
    path.join(backend, "Cargo.lock"),
  ];
  const before = files.map((file) => readFileSync(file, "utf8"));
  assert.notEqual(run("set", "not-a-version").status, 0);
  assert.deepEqual(
    files.map((file) => readFileSync(file, "utf8")),
    before,
  );
});
