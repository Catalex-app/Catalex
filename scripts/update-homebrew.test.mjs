import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { updateHomebrewTap } from "./update-homebrew.mjs";

const installer = Buffer.from("published installer fixture");
const checksum = createHash("sha256").update(installer).digest("hex");
const source = "https://api.github.com/repos/Catalex-app/Catalex";
const destination =
  "https://api.github.com/repos/Catalex-app/homebrew-tap/contents/Casks/catalex.rb";
const assetUrl =
  "https://github.com/Catalex-app/Catalex/releases/download/v0.2.0/Catalex-0.2.0-arm64.dmg";
const stable = (tag_name, extra = {}) => ({
  tag_name,
  draft: false,
  prerelease: false,
  ...extra,
});

function fixture(options = {}) {
  const calls = [];
  const messages = [];
  const content =
    options.content ??
    `cask "catalex" do\n  version "${options.currentVersion ?? "0.1.0"}"\n  sha256 "${options.currentChecksum ?? "a".repeat(64)}"\n\n  app "Catalex.app"\nend\n`;
  const release = stable("v0.2.0", {
    published_at: "2026-11-03T00:00:00Z",
    assets: [
      {
        name: "Catalex-0.2.0-arm64.dmg",
        state: "uploaded",
        size: installer.length,
        browser_download_url: assetUrl,
        digest: `sha256:${checksum}`,
        ...options.asset,
      },
    ],
    ...options.release,
  });
  const pages = options.pages ?? [[stable("v0.2.0"), stable("v0.1.0")]];
  const fetchImpl = async (url, request = {}) => {
    calls.push({ url, ...request });
    if (url === `${source}/releases/tags/v0.2.0`) {
      return Response.json(release);
    }
    if (url.startsWith(`${source}/releases?`)) {
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json(pages[page - 1]);
    }
    if (url === `${destination}?ref=main`) {
      if (options.readStatus)
        return new Response(null, { status: options.readStatus });
      return Response.json({
        type: "file",
        encoding: "base64",
        sha: "existing-file-sha",
        content: Buffer.from(content).toString("base64"),
      });
    }
    if (url === assetUrl) {
      return new Response(options.download ?? installer, {
        status: options.downloadStatus ?? 200,
      });
    }
    if (url === destination && request.method === "PUT") {
      return Response.json({}, { status: options.writeStatus ?? 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return {
    calls,
    messages,
    content,
    run: (extra = {}) =>
      updateHomebrewTap({
        tag: "v0.2.0",
        sourceToken: "source-test-token",
        tapToken: "tap-test-token",
        fetchImpl,
        log: (message) => messages.push(message),
        ...extra,
      }),
  };
}

test("updates only version and checksum, using separate tokens and optimistic concurrency", async () => {
  const f = fixture();
  assert.equal(await f.run(), "updated");
  const writes = f.calls.filter((call) => call.method === "PUT");
  assert.equal(writes.length, 1);
  const payload = JSON.parse(writes[0].body);
  assert.equal(payload.sha, "existing-file-sha");
  assert.equal(payload.branch, "main");
  assert.equal(payload.message, "catalex 0.2.0");
  assert.equal(
    Buffer.from(payload.content, "base64").toString(),
    f.content
      .replace('version "0.1.0"', 'version "0.2.0"')
      .replace("a".repeat(64), checksum),
  );
  for (const call of f.calls) {
    if (call.url === assetUrl) assert.equal(call.headers, undefined);
    else
      assert.equal(
        call.headers.Authorization,
        call.url.startsWith(source)
          ? "Bearer source-test-token"
          : "Bearer tap-test-token",
      );
  }
  assert.ok(f.messages.every((message) => !message.includes("test-token")));
});

test("rejects invalid tags and missing credentials before any request", async () => {
  for (const tag of [
    undefined,
    "v0.2.0-beta",
    "v00.2.0",
    "0.2.0",
    'v0.2.0";exit',
  ]) {
    const f = fixture();
    await assert.rejects(f.run({ tag }), /stable tag/);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.run({ tapToken: "" }), /HOMEBREW_TAP_TOKEN/);
  assert.equal(f.calls.length, 0);
});

test("drafts, prereleases, unpublished releases, and mismatched tags cannot write", async () => {
  for (const release of [
    { draft: true },
    { prerelease: true },
    { published_at: null },
    { tag_name: "v0.3.0" },
  ]) {
    const f = fixture({ release });
    await assert.rejects(f.run(), /published stable release/);
    assert.equal(f.calls.length, 1);
  }
});

test("a delayed older release cannot downgrade the tap, including across release pages", async () => {
  const firstPage = Array.from({ length: 100 }, () => stable("v0.2.0"));
  const f = fixture({ pages: [firstPage, [stable("v0.10.0")]] });
  assert.equal(await f.run(), "skipped");
  assert.equal(f.calls.length, 3);
  const newerTap = fixture({ currentVersion: "0.10.0" });
  assert.equal(await newerTap.run(), "skipped");
  assert.ok(!newerTap.calls.some((call) => call.url === assetUrl));
});

test("newer previews and drafts do not block the stable tap update", async () => {
  const f = fixture({
    pages: [
      [
        stable("v0.2.0"),
        stable("v0.3.0-beta"),
        stable("v0.4.0", { draft: true }),
        stable("v0.5.0", { prerelease: true }),
      ],
    ],
  });
  assert.equal(await f.run(), "updated");
});

test("missing, duplicate, incomplete, and unexpected installers cannot update the tap", async () => {
  for (const options of [
    { release: { assets: [] } },
    {
      release: {
        assets: [
          { name: "Catalex-0.2.0-arm64.dmg" },
          { name: "Catalex-0.2.0-arm64.dmg" },
        ],
      },
    },
    { asset: { state: "starter" } },
    { asset: { size: 0 } },
    { asset: { browser_download_url: "https://example.com/installer.dmg" } },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run(), /exactly one uploaded/);
    assert.ok(!f.calls.some((call) => call.method === "PUT"));
  }
});

test("failed, truncated, and checksum-mismatched downloads cannot write", async () => {
  for (const options of [
    { downloadStatus: 404 },
    { download: Buffer.from("truncated") },
    { asset: { digest: `sha256:${"b".repeat(64)}` } },
  ]) {
    const f = fixture(options);
    await assert.rejects(
      f.run(),
      /download failed|size does not match|checksum does not match/,
    );
    assert.ok(!f.calls.some((call) => call.method === "PUT"));
  }
});

test("identical retries are no-ops and replaced same-version installers are rejected", async () => {
  const f = fixture({ currentVersion: "0.2.0", currentChecksum: checksum });
  assert.equal(await f.run(), "unchanged");
  assert.ok(!f.calls.some((call) => call.method === "PUT"));
  const replaced = fixture({ currentVersion: "0.2.0" });
  await assert.rejects(replaced.run(), /same version has a different checksum/);
  assert.ok(!replaced.calls.some((call) => call.method === "PUT"));
});

test("dry run computes the checksum without requiring a tap secret or writing", async () => {
  const f = fixture({ asset: { digest: null } });
  assert.equal(await f.run({ dryRun: true, tapToken: "" }), "dry-run");
  assert.ok(f.messages[0].includes(checksum));
  assert.ok(!f.calls.some((call) => call.method === "PUT"));
});

test("unexpected cask contents and API errors fail visibly without overwriting", async () => {
  const malformed = fixture({ content: 'cask "catalex" do\nend\n' });
  await assert.rejects(malformed.run(), /one stable version/);
  assert.ok(!malformed.calls.some((call) => call.method === "PUT"));
  const unreadable = fixture({ readStatus: 403 });
  await assert.rejects(unreadable.run(), /GitHub read failed \(403\)/);
  assert.ok(!unreadable.calls.some((call) => call.method === "PUT"));
  for (const writeStatus of [403, 409, 422]) {
    const f = fixture({ writeStatus });
    await assert.rejects(f.run(), /GitHub write failed/);
    assert.equal(f.calls.filter((call) => call.method === "PUT").length, 1);
  }
});
