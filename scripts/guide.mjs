#!/usr/bin/env node
// The agent's app guide ships the user guide. docs/ is the only place to edit
// it; this copies the pages into the built-in skill, or checks the copies.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const branding = JSON.parse(
  readFileSync(path.join(root, "branding.json"), "utf8"),
);
const source = path.join(root, "docs");
const target = path.join(
  root,
  "apps/desktop/backend/resources",
  branding.namespace,
  "skills",
  `${branding.namespace}-guide`,
  "docs",
);
const mode = process.argv[2];
if (process.argv.length !== 3 || !["sync", "check"].includes(mode))
  throw new Error("Usage: guide.mjs [sync|check]");

// The user guide only: its index page and the development pages stay out.
const pages = JSON.parse(
  readFileSync(path.join(source, "navigation.json"), "utf8"),
)[0].pages.filter((page) => page !== "README.md");
const existing = existsSync(target) ? readdirSync(target).sort() : [];
const stale =
  existing.join("\n") !== [...pages].sort().join("\n") ||
  pages.some(
    (page) =>
      readFileSync(path.join(source, page), "utf8") !==
      readFileSync(path.join(target, page), "utf8"),
  );
if (mode === "check") {
  if (stale) {
    console.error(
      "The agent guide is out of date with docs/. Run `pnpm guide:sync`.",
    );
    process.exit(1);
  }
  console.log("Agent guide matches docs/");
} else {
  if (stale) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const page of pages)
      writeFileSync(
        path.join(target, page),
        readFileSync(path.join(source, page)),
      );
  }
  console.log(`Agent guide ${stale ? "updated from" : "matches"} docs/`);
}
