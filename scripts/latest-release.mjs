#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Accept gh api --paginate --slurp output. Compare numeric components rather
// than publication dates or lexical tag order; drafts and prereleases cannot win.
export function latestStableRelease(pages) {
  let latest = null;
  let version = null;
  for (const release of pages.flat()) {
    if (release.draft || release.prerelease) continue;
    const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(
      release.tag_name,
    );
    if (!match) continue;
    const candidate = match.slice(1).map(BigInt);
    const difference = version
      ? candidate.findIndex((part, index) => part !== version[index])
      : -1;
    if (
      !version ||
      (difference >= 0 && candidate[difference] > version[difference])
    ) {
      latest = release.tag_name;
      version = candidate;
    }
  }
  return latest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const latest = latestStableRelease(JSON.parse(readFileSync(0, "utf8")));
  if (latest) console.log(latest);
}
