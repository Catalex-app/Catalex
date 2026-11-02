import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./build-desktop.mjs", import.meta.url));
function runBuild(t, mode, fail = "", discovery = undefined) {
  const dir = mkdtempSync(path.join(tmpdir(), "catalex-build-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "commands.jsonl");
  const pnpm = path.join(dir, "pnpm.mjs");
  writeFileSync(
    pnpm,
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_BUILD_LOG, JSON.stringify({ args, discovery: process.env.CSC_IDENTITY_AUTO_DISCOVERY, profile: process.env.APPLE_KEYCHAIN_PROFILE }) + "\\n");
if (args[0] === process.env.TEST_FAIL_COMMAND) process.exit(7);
`,
  );
  const result = spawnSync(process.execPath, [script, mode], {
    encoding: "utf8",
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: discovery,
      APPLE_KEYCHAIN_PROFILE: "",
      npm_execpath: pnpm,
      TEST_BUILD_LOG: log,
      TEST_FAIL_COMMAND: fail,
    },
  });
  const entries = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  return {
    result,
    commands: entries.map((entry) => entry.args),
    discoveries: entries.map((entry) => entry.discovery),
    profiles: entries.map((entry) => entry.profile),
  };
}

test("native build failure stops packaging and preserves the exit status", (t) => {
  const { result, commands } = runBuild(t, "build", "build:native");
  assert.equal(result.status, 7);
  assert.equal(commands.length, 3);
  assert.ok(!commands.flat().includes("electron-builder"));
});

test("local packaging disables certificate discovery unless explicitly enabled", (t) => {
  for (const mode of ["build", "package"]) {
    for (const discovery of [undefined, "true", "false"]) {
      const { result, discoveries } = runBuild(t, mode, "", discovery);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(discoveries.every((value) => value === (discovery ?? "false")));
    }
  }
});

test("local build and distributable packaging never publish a release", (t) => {
  for (const mode of ["build", "package"]) {
    const { result, commands } = runBuild(t, mode);
    assert.equal(result.status, 0, result.stderr);
    const packaging = commands.at(-1);
    assert.equal(packaging[packaging.indexOf("--publish") + 1], "never");
    assert.equal(packaging.includes("--dir"), mode === "build");
    assert.ok(commands.find((args) => args.includes("build:claude-sidecar")));
  }
});

test("development prepares the helpers but does not package the app", (t) => {
  const { result, commands } = runBuild(t, "dev");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(commands.at(-1).at(-1), "electron:dev");
  assert.ok(!commands.flat().includes("electron-builder"));
});

test(
  "signed packaging uses the local notarization profile and never publishes",
  {
    skip: process.platform !== "darwin",
  },
  (t) => {
    const { result, commands, discoveries, profiles } = runBuild(t, "signed");
    assert.equal(result.status, 0, result.stderr);
    assert.ok(discoveries.every((value) => value === "true"));
    assert.ok(profiles.every((value) => value === "catalex-notary"));
    const packaging = commands.at(-1);
    assert.equal(
      packaging[packaging.indexOf("--config") + 1],
      "electron-builder.signed.cjs",
    );
    assert.equal(packaging[packaging.indexOf("--publish") + 1], "never");
    assert.equal(packaging[packaging.indexOf("--mac") + 1], "dmg");
    assert.equal(packaging.includes("--dir"), false);
  },
);

test("signed configuration requires notarization credentials and rejects ad-hoc signing", () => {
  const config = fileURLToPath(
    new URL("../apps/desktop/electron-builder.signed.cjs", import.meta.url),
  );
  const load = (profile, identity = "") =>
    spawnSync(
      process.execPath,
      [
        "-e",
        `
    const config = require(process.argv[1]);
    if (!config.forceCodeSigning || !config.mac.notarize || config.mac.type !== "distribution" || config.mac.identity === "-") process.exit(2);
  `,
        config,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          APPLE_KEYCHAIN_PROFILE: profile,
          CSC_NAME: identity,
        },
      },
    );
  assert.notEqual(load("").status, 0);
  assert.notEqual(load(" ").status, 0);
  assert.notEqual(load("test-profile", "-").status, 0);
  assert.equal(load("test-profile").status, 0);
});
