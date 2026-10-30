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

const workflow = readFileSync(
  new URL("../.github/workflows/build-desktop.yml", import.meta.url),
  "utf8",
);
const notes = readFileSync(
  new URL("./release-notes.mjs", import.meta.url),
  "utf8",
);
const asset = { name: "Catalex-0.1.0-arm64.dmg", state: "uploaded", size: 100 };

function stepShell(name) {
  const step = workflow
    .split(`      - name: ${name}\n`)[1]
    ?.split("\n      - ")[0];
  assert.ok(step, `Missing workflow step: ${name}`);
  return step.split("        run: |\n")[1].replace(/^ {10}/gm, "");
}

function runStep(t, name, scenario = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "catalex-artifact-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "calls.jsonl");
  const output = path.join(dir, "output");
  const stateFile = path.join(dir, "release.json");
  writeFileSync(log, "");
  writeFileSync(output, "");
  writeFileSync(
    stateFile,
    JSON.stringify({
      exists: !scenario.viewFails,
      isDraft: scenario.draft ?? true,
      assets: scenario.assets ?? [asset],
    }),
  );
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ version: scenario.version ?? "0.1.0" }),
  );
  writeFileSync(
    path.join(dir, "branding.json"),
    JSON.stringify({ productName: "Catalex" }),
  );
  writeFileSync(
    path.join(dir, "CHANGELOG.md"),
    `# Changelog\n\n## [${scenario.version ?? "0.1.0"}]\n\n- Initial public release.\n`,
  );
  mkdirSync(path.join(dir, "scripts"));
  writeFileSync(path.join(dir, "scripts/release-notes.mjs"), notes);
  mkdirSync(path.join(dir, "installers"));
  for (const name of scenario.installers ?? [asset.name])
    writeFileSync(path.join(dir, "installers", name), "installer fixture");
  writeFileSync(
    path.join(dir, "gh"),
    `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const scenario = JSON.parse(process.env.TEST_SCENARIO);
const state = JSON.parse(readFileSync(process.env.TEST_STATE, "utf8"));
appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + "\\n");
const save = () => writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
if (args.includes("DELETE")) process.exit(scenario.deleteFails ? 1 : 0);
let data;
if (args[0] === "release" && args[1] === "view") {
  if (!state.exists) process.exit(1);
  data = state;
} else if (args[0] === "release" && args[1] === "create") {
  if (scenario.createFails) process.exit(1);
  state.exists = true;
  state.isDraft = args.includes("--draft");
  state.assets = [];
  save(); process.exit(0);
} else if (args[0] === "release" && args[1] === "upload") {
  if (scenario.uploadFails) process.exit(1);
  state.assets = [${JSON.stringify(asset)}];
  save(); process.exit(0);
} else if (args[0] === "release" && args[1] === "edit") {
  if (scenario.editFails) process.exit(1);
  if (args.includes("--draft=false")) state.isDraft = false;
  if (args.includes("--draft=true")) state.isDraft = true;
  if (args.includes("--latest") || args.includes("--latest=true")) state.latest = true;
  save(); process.exit(0);
} else if (args.some(arg => arg.includes("/releases/tags/"))) {
  if (scenario.releaseReadFails) process.exit(1);
  data = { draft: state.isDraft, assets: state.assets };
} else if (args.some(arg => arg.includes("/actions/runs/"))) {
  if (scenario.listFails) process.exit(1);
  data = { artifacts: scenario.artifacts ?? [
    { id: 7, name: "catalex-electron-macos-arm64" },
    { id: 8, name: "unrelated-test-results" }
  ] };
} else { throw new Error("Unexpected gh command: " + JSON.stringify(args)); }
const query = args[args.indexOf("--jq") + 1];
const result = spawnSync("jq", ["-r", query], { input: JSON.stringify(data), encoding: "utf8" });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status);
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", ["-c", stepShell(name)], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      GH_TOKEN: "test-only",
      GH_REPO: "owner/repo",
      RELEASE_TAG: `v${scenario.version ?? "0.1.0"}`,
      RELEASE_RUN_ID: "123",
      GITHUB_OUTPUT: output,
      TEST_LOG: log,
      TEST_STATE: stateFile,
      TEST_SCENARIO: JSON.stringify(scenario),
    },
  });
  const calls = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  return {
    result,
    calls,
    output: readFileSync(output, "utf8"),
    state: JSON.parse(readFileSync(stateFile, "utf8")),
  };
}

const prepare = "Prepare draft installers and changelog";
const cleanup = "Delete temporary installer after draft upload";

test("a first release uploads its installer and stays a draft without becoming Latest", (t) => {
  const { result, calls, state } = runStep(t, prepare, { viewFails: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.isDraft, true);
  assert.equal(state.latest, undefined);
  assert.deepEqual(state.assets, [asset]);
  assert.ok(
    calls.find((args) => args[1] === "create").includes("--verify-tag"),
  );
  assert.ok(calls.find((args) => args[1] === "create").includes("--draft"));
  assert.ok(!workflow.includes("--draft=false"));
});

test("an incomplete draft can resume without creating another release", (t) => {
  const { result, calls, state } = runStep(t, prepare, { assets: [] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.isDraft, true);
  assert.ok(!calls.some((args) => args[1] === "create"));
  assert.ok(calls.some((args) => args[1] === "upload"));
});

test("published releases cannot be edited or have installers replaced", (t) => {
  const { result, calls, state } = runStep(t, prepare, { draft: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.isDraft, false);
  assert.deepEqual(
    calls.map((args) => args[1]),
    ["view"],
  );
});

test("missing or multiple installers cannot create a draft", (t) => {
  for (const installers of [[], ["one.dmg", "two.dmg"]]) {
    const { result, calls } = runStep(t, prepare, {
      viewFails: true,
      installers,
    });
    assert.notEqual(result.status, 0);
    assert.equal(calls.length, 0);
  }
});

test("draft preparation fails visibly on create, upload, or notes errors", (t) => {
  for (const scenario of [
    { viewFails: true, createFails: true },
    { uploadFails: true },
    { editFails: true },
  ]) {
    const { result, state } = runStep(t, prepare, scenario);
    assert.notEqual(result.status, 0);
    assert.equal(state.isDraft, true);
  }
});

test("prerelease versions create drafts marked as prereleases", (t) => {
  const { result, calls, state } = runStep(t, prepare, {
    viewFails: true,
    version: "0.1.0-beta.1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    calls.find((args) => args[1] === "create").includes("--prerelease=true"),
  );
  assert.equal(state.isDraft, true);
});

test("completed draft and published retries skip the deleted temporary download", (t) => {
  for (const [scenario, expected] of [
    [{}, "true"],
    [{ draft: false, assets: [] }, "true"],
    [{ assets: [] }, "false"],
    [{ viewFails: true }, "false"],
    [{ assets: [{ ...asset, size: 0 }] }, "false"],
  ]) {
    const { result, output } = runStep(
      t,
      "Check whether release is already prepared",
      scenario,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(output, `ready=${expected}\n`);
  }
  assert.equal(
    workflow.split("if: steps.existing-release.outputs.ready != 'true'")
      .length - 1,
    2,
  );
});

test("cleanup deletes only this run's installer after verifying its draft upload", (t) => {
  for (const draft of [true, false]) {
    const { result, calls } = runStep(t, cleanup, { draft });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(calls[0].includes("repos/owner/repo/releases/tags/v0.1.0"));
    assert.ok(
      calls[1].includes(
        "repos/owner/repo/actions/runs/123/artifacts?per_page=100",
      ),
    );
    assert.ok(calls[1].includes("--paginate"));
    assert.deepEqual(
      calls.filter((args) => args.includes("DELETE")),
      [["api", "--method", "DELETE", "repos/owner/repo/actions/artifacts/7"]],
    );
  }
});

test("cleanup retains temporary artifacts when the uploaded asset is absent or unverifiable", (t) => {
  for (const scenario of [
    { assets: [] },
    { assets: [{ name: "installer.zip", state: "uploaded", size: 100 }] },
    { assets: [{ ...asset, state: "starter" }] },
    { assets: [{ ...asset, size: 0 }] },
    { releaseReadFails: true },
  ]) {
    const { result, calls } = runStep(t, cleanup, scenario);
    assert.notEqual(result.status, 0);
    assert.equal(calls.length, 1);
  }
});

test("cleanup is safe to repeat and reports list/delete errors", (t) => {
  const { result, calls } = runStep(t, cleanup, { artifacts: [] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!calls.some((args) => args.includes("DELETE")));
  for (const scenario of [{ listFails: true }, { deleteFails: true }])
    assert.notEqual(runStep(t, cleanup, scenario).result.status, 0);
});
