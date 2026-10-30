#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ROOT_PACKAGE = path.join(ROOT, "package.json");
const DESKTOP_PACKAGE = path.join(ROOT, "apps/desktop/package.json");
const DESKTOP_SIDECAR_PACKAGE = path.join(
  ROOT,
  "apps/desktop-sidecar/package.json",
);
const CARGO_TOML = path.join(ROOT, "apps/desktop/backend/Cargo.toml");
const CARGO_LOCK = path.join(ROOT, "apps/desktop/backend/Cargo.lock");
const LOCK_VERSION_PATTERN =
  /(\[\[package\]\]\r?\nname = "catalex-desktop"\r?\nversion = ")([^"]+)(")/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function syncDesktopVersions(version) {
  const desktopPackage = readJson(DESKTOP_PACKAGE);
  if (desktopPackage.version !== version) {
    desktopPackage.version = version;
    writeJson(DESKTOP_PACKAGE, desktopPackage);
  }

  const sidecarPackage = readJson(DESKTOP_SIDECAR_PACKAGE);
  if (sidecarPackage.version !== version) {
    sidecarPackage.version = version;
    writeJson(DESKTOP_SIDECAR_PACKAGE, sidecarPackage);
  }

  const cargo = fs.readFileSync(CARGO_TOML, "utf8");
  const packageVersionPattern = /(\[package\][\s\S]*?\nversion = ")([^"]+)(")/;
  if (!packageVersionPattern.test(cargo)) {
    throw new Error("Could not find [package] version in Cargo.toml");
  }
  const updatedCargo = cargo.replace(packageVersionPattern, `$1${version}$3`);

  if (updatedCargo !== cargo) {
    fs.writeFileSync(CARGO_TOML, updatedCargo);
  }

  // Locked builds require the root crate's version to match its manifest.
  // Preserve every dependency version and checksum in the lockfile.
  const lock = fs.readFileSync(CARGO_LOCK, "utf8");
  if (!LOCK_VERSION_PATTERN.test(lock)) {
    throw new Error("Could not find catalex-desktop in Cargo.lock");
  }
  const updatedLock = lock.replace(LOCK_VERSION_PATTERN, `$1${version}$3`);
  if (updatedLock !== lock) fs.writeFileSync(CARGO_LOCK, updatedLock);
}

function getDesktopVersions() {
  const rootVersion = getRootVersion();
  const desktopPackage = readJson(DESKTOP_PACKAGE);
  const sidecarPackage = readJson(DESKTOP_SIDECAR_PACKAGE);
  const cargo = fs.readFileSync(CARGO_TOML, "utf8");
  const packageVersionPattern = /\[package\][\s\S]*?\nversion = "([^"]+)"/;
  const cargoMatch = cargo.match(packageVersionPattern);
  if (!cargoMatch) {
    throw new Error("Could not find [package] version in Cargo.toml");
  }

  const lockMatch = fs
    .readFileSync(CARGO_LOCK, "utf8")
    .match(LOCK_VERSION_PATTERN);
  if (!lockMatch) {
    throw new Error("Could not find catalex-desktop in Cargo.lock");
  }
  return {
    root: rootVersion,
    desktopPackage: desktopPackage.version,
    desktopSidecarPackage: sidecarPackage.version,
    cargo: cargoMatch[1],
    cargoLock: lockMatch[2],
  };
}

function checkDesktopVersions() {
  const versions = getDesktopVersions();
  const expected = versions.root;
  const mismatches = Object.entries(versions).filter(
    ([, version]) => version !== expected,
  );

  if (mismatches.length > 0) {
    const details = Object.entries(versions)
      .map(([source, version]) => `  ${source}: ${version}`)
      .join("\n");
    throw new Error(
      `Desktop version files are out of sync. Run pnpm version:sync.\n${details}`,
    );
  }
}

function ensureValidSemver(version) {
  const semverPattern =
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (!semverPattern.test(version)) {
    throw new Error(
      `Invalid version "${version}". Use semver format like 0.1.0 or 1.2.3-beta.1`,
    );
  }
}

function getRootVersion() {
  const rootPackage = readJson(ROOT_PACKAGE);
  if (typeof rootPackage.version !== "string" || !rootPackage.version.trim()) {
    throw new Error("Root package.json does not contain a valid version");
  }
  return rootPackage.version;
}

function setRootVersion(version) {
  const rootPackage = readJson(ROOT_PACKAGE);
  rootPackage.version = version;
  writeJson(ROOT_PACKAGE, rootPackage);
}

function main() {
  const mode = process.argv[2];

  if (mode === "sync") {
    const rootVersion = getRootVersion();
    syncDesktopVersions(rootVersion);
    console.log(`Synced desktop versions to ${rootVersion}`);
    return;
  }

  if (mode === "check") {
    checkDesktopVersions();
    console.log(`Desktop versions are synced to ${getRootVersion()}`);
    return;
  }

  if (mode === "set") {
    const nextVersion = process.argv[3];
    if (!nextVersion) {
      throw new Error("Missing version. Usage: pnpm version:set <version>");
    }
    ensureValidSemver(nextVersion);
    setRootVersion(nextVersion);
    syncDesktopVersions(nextVersion);
    console.log(`Set project version to ${nextVersion}`);
    return;
  }

  throw new Error("Usage: node scripts/version.mjs <sync|check|set> [version]");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
