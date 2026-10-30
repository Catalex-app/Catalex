import assert from "node:assert/strict";
import { test } from "node:test";
import { latestStableRelease } from "./latest-release.mjs";

const release = (tag_name, extra = {}) => ({
  tag_name,
  draft: false,
  prerelease: false,
  ...extra,
});

test("highest stable version wins regardless of publication order and page", () => {
  const releases = [release("v0.34.3"), release("v0.34.2"), release("v0.9.9")];
  assert.equal(latestStableRelease([releases]), "v0.34.3");
  assert.equal(latestStableRelease([releases.toReversed()]), "v0.34.3");
  assert.equal(
    latestStableRelease([releases, [release("v0.100.0")]]),
    "v0.100.0",
  );
  assert.equal(latestStableRelease([releases, [release("v1.0.0")]]), "v1.0.0");
});

test("unpublished, prerelease and unrelated tags never replace stable releases", () => {
  assert.equal(
    latestStableRelease([
      [
        release("v0.34.3"),
        release("v1.0.0", { draft: true }),
        release("v2.0.0", { prerelease: true }),
        release("v3.0.0-beta.1"),
        release("nightly"),
        release("v04.0.0"),
      ],
    ]),
    "v0.34.3",
  );
  assert.equal(latestStableRelease([]), null);
  assert.equal(latestStableRelease([[release("v1.0.0-rc.1")]]), null);
});
