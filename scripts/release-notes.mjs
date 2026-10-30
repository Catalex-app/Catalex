#!/usr/bin/env node
import { readFileSync } from "node:fs";

// Run from the repository root. Output only the matching release notes so CI
// can use stdout as the GitHub release body.
try {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const tag = process.argv[2];
  if (!tag || process.argv.length !== 3 || tag !== `v${version}`) {
    throw new Error(`Release tag must match package.json: v${version}`);
  }
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const sections = changelog.split(/^## /m).slice(1);
  const matches = sections.filter((section) => {
    const heading = section.split(/\r?\n/, 1)[0];
    return heading === `[${version}]` || heading.startsWith(`[${version}] - `);
  });
  if (matches.length !== 1) {
    throw new Error(
      `CHANGELOG.md must contain exactly one ## [${version}] entry`,
    );
  }
  const notes = matches[0].slice(matches[0].indexOf("\n") + 1).trim();
  if (!notes || !matches[0].includes("\n")) {
    throw new Error(`CHANGELOG.md entry for ${version} is empty`);
  }
  console.log(notes);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
