#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { latestStableRelease } from "./latest-release.mjs";

const source = "Catalex-app/Catalex";
const tap = "Catalex-app/homebrew-tap";
const caskPath = `repos/${tap}/contents/Casks/catalex.rb`;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function compareVersions(left, right) {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  const index = a.findIndex((part, i) => part !== b[i]);
  return index < 0 ? 0 : a[index] > b[index] ? 1 : -1;
}

export async function updateHomebrewTap({
  tag,
  sourceToken,
  tapToken,
  dryRun = false,
  fetchImpl = fetch,
  log = console.log,
}) {
  const version = tag?.startsWith("v") ? tag.slice(1) : "";
  if (!stableVersion.test(version)) {
    throw new Error("RELEASE_TAG must be a stable tag such as v0.1.0.");
  }
  if (!dryRun && !tapToken) {
    throw new Error(
      "Set the HOMEBREW_TAP_TOKEN Actions secret with Contents read/write access to Catalex-app/homebrew-tap.",
    );
  }

  async function api(endpoint, token, body) {
    const response = await fetchImpl(`https://api.github.com/${endpoint}`, {
      method: body ? "PUT" : "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(
        `GitHub ${body ? "write" : "read"} failed (${response.status}) for ${endpoint}. Check repository access; rerun after resolving conflicts or permissions.`,
      );
    }
    return response.json();
  }

  const release = await api(
    `repos/${source}/releases/tags/${tag}`,
    sourceToken,
  );
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    !release.published_at
  ) {
    throw new Error("Only a published stable release can update Homebrew.");
  }

  // GitHub's Latest flag and publication order can point to an older version.
  const pages = [];
  for (let page = 1; ; page++) {
    const releases = await api(
      `repos/${source}/releases?per_page=100&page=${page}`,
      sourceToken,
    );
    pages.push(releases);
    if (releases.length < 100) break;
  }
  if (latestStableRelease(pages) !== tag) {
    log(`Skipping ${tag}: it is not the highest published stable version.`);
    return "skipped";
  }

  const name = `Catalex-${version}-arm64.dmg`;
  const assets = release.assets.filter((asset) => asset.name === name);
  const url = `https://github.com/${source}/releases/download/${tag}/${name}`;
  if (
    assets.length !== 1 ||
    assets[0].state !== "uploaded" ||
    !Number.isSafeInteger(assets[0].size) ||
    assets[0].size <= 0 ||
    assets[0].browser_download_url !== url
  ) {
    throw new Error(`Release must contain exactly one uploaded ${name}.`);
  }
  const asset = assets[0];
  const file = await api(`${caskPath}?ref=main`, tapToken);
  if (file.type !== "file" || file.encoding !== "base64" || !file.sha) {
    throw new Error("Expected an existing Casks/catalex.rb file on tap main.");
  }
  const content = Buffer.from(file.content, "base64").toString("utf8");
  const versions = [...content.matchAll(/^ {2}version "([^"]+)"$/gm)];
  const checksums = [...content.matchAll(/^ {2}sha256 "([a-f0-9]{64})"$/gm)];
  if (
    versions.length !== 1 ||
    !stableVersion.test(versions[0][1]) ||
    checksums.length !== 1
  ) {
    throw new Error(
      "Cask must have one stable version and one SHA-256 stanza.",
    );
  }
  const currentVersion = versions[0][1];
  if (compareVersions(currentVersion, version) > 0) {
    log(`Skipping ${tag}: the tap already contains ${currentVersion}.`);
    return "skipped";
  }

  // Public asset downloads never receive either repository access token.
  const download = await fetchImpl(url, {
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!download.ok || !download.body) {
    throw new Error(`Installer download failed (${download.status}).`);
  }
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of download.body) {
    size += chunk.length;
    hash.update(chunk);
  }
  const checksum = hash.digest("hex");
  if (size !== asset.size)
    throw new Error("Installer size does not match GitHub.");
  if (asset.digest && asset.digest !== `sha256:${checksum}`) {
    throw new Error("Installer checksum does not match GitHub.");
  }
  if (currentVersion === version) {
    if (checksums[0][1] !== checksum) {
      throw new Error(
        "The same version has a different checksum. Publish a new version instead of replacing a released installer.",
      );
    }
    log(`Homebrew already contains ${tag}; no commit needed.`);
    return "unchanged";
  }
  const updated = content
    .replace(versions[0][0], `  version "${version}"`)
    .replace(checksums[0][0], `  sha256 "${checksum}"`);
  if (dryRun) {
    log(`Would update ${tap}/Casks/catalex.rb to ${version} (${checksum}).`);
    return "dry-run";
  }
  await api(caskPath, tapToken, {
    message: `catalex ${version}`,
    branch: "main",
    sha: file.sha,
    content: Buffer.from(updated).toString("base64"),
  });
  log(`Updated ${tap}/Casks/catalex.rb to ${version}.`);
  return "updated";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await updateHomebrewTap({
      tag: process.env.RELEASE_TAG,
      sourceToken: process.env.GITHUB_TOKEN,
      tapToken: process.env.HOMEBREW_TAP_TOKEN,
      dryRun: process.env.DRY_RUN === "1",
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
