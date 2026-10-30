#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2] ?? "build";
if (process.argv.length > 3 || !["build", "dev", "package"].includes(mode)) {
  throw new Error("Usage: build-desktop.mjs [build|dev|package]");
}
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run this script through pnpm.");

function run(...args) {
  const result = spawnSync(process.execPath, [pnpm, ...args], {
    cwd: root,
    stdio: "inherit",
    // Local builds should not silently select a certificate from the keychain.
    env: { CSC_IDENTITY_AUTO_DISCOVERY: "false", ...process.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("branding:check");
run("version:check");
run("build:native");
run("build:claude-sidecar");
run("--filter=@catalex/desktop", "electron:typecheck");
run("--filter=@catalex/desktop", "electron:build");
if (mode === "dev") {
  run("--filter=@catalex/desktop", "electron:dev");
} else {
  run("--filter=@catalex/desktop", "build");
  run(
    "--filter=@catalex/desktop",
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.cjs",
    "--publish",
    "never",
    ...(mode === "build" ? ["--dir"] : []),
  );
}
