import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./release-notes.mjs", import.meta.url));
function extract(t, changelog, tag = "v1.2.3", version = "1.2.3") {
  const dir = mkdtempSync(path.join(tmpdir(), "catalex-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(path.join(dir, "CHANGELOG.md"), changelog);
  return spawnSync(process.execPath, [script, tag], {
    cwd: dir,
    encoding: "utf8",
  });
}

test("extracts only the requested version, preserving Markdown", (t) => {
  const result = extract(
    t,
    "# Changelog\n\n## [Unreleased]\nFuture\n\n## [1.2.3] - 2026-09-18\n\n### Fixed\n- **Saving** works.\n\n## [1.2.2]\nOlder\n",
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "### Fixed\n- **Saving** works.\n");
});

test("supports prerelease versions and Windows line endings", (t) => {
  const result = extract(
    t,
    "## [1.2.3-beta.1]\r\n\r\n- Preview.\r\n",
    "v1.2.3-beta.1",
    "1.2.3-beta.1",
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "- Preview.\n");
});

test("rejects a tag for a different version", (t) => {
  const result = extract(t, "## [1.2.3]\n- Update.\n", "v1.2.4");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must match package.json/);
  assert.equal(result.stdout, "");
});

test("rejects missing, duplicate, and empty changelog entries", (t) => {
  for (const content of [
    "## [1.2.2]\n- Old.\n",
    "## [1.2.3]\n- First.\n## [1.2.3]\n- Second.\n",
    "## [1.2.3]\n\n## [1.2.2]\n- Old.\n",
    "## [1.2.3]",
  ]) {
    const result = extract(t, content);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
});
