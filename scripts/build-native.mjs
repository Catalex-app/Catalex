#!/usr/bin/env node
// Build on the target operating system. Linux needs the Tectonic pkg-config
// libraries. Windows needs vcpkg ports harfbuzz[graphite2], freetype, icu and
// fontconfig with x64-windows-static-md (or the matching architecture triplet).
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "apps/desktop/backend/Cargo.toml");
const destination = path.join(root, "apps/desktop/dist/native");
const environment = { ...process.env };
const branding = JSON.parse(
  readFileSync(path.join(root, "branding.json"), "utf8"),
);
const runTests = process.argv.includes("--test");

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}): ${result.stderr?.trim() ?? "see output above"}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

function prependPaths(variable, paths) {
  const existing = environment[variable]?.split(path.delimiter) ?? [];
  environment[variable] = [
    ...new Set([...paths.filter(existsSync), ...existing]),
  ]
    .filter(Boolean)
    .join(path.delimiter);
}

function configureDependencies() {
  const vcpkgRoot = environment.VCPKG_ROOT ?? path.join(homedir(), "vcpkg");
  if (!environment.TECTONIC_DEP_BACKEND) {
    environment.TECTONIC_DEP_BACKEND =
      environment.VCPKG_ROOT || existsSync(path.join(vcpkgRoot, ".vcpkg-root"))
        ? "vcpkg"
        : "pkg-config";
  }
  environment.CXXFLAGS ??=
    process.platform === "win32" ? "/std:c++17" : "-std=c++17";
  if (environment.TECTONIC_DEP_BACKEND === "vcpkg") {
    environment.VCPKG_ROOT = vcpkgRoot;
    if (!existsSync(path.join(vcpkgRoot, ".vcpkg-root"))) {
      throw new Error(`VCPKG_ROOT is not a vcpkg checkout: ${vcpkgRoot}`);
    }
  } else if (process.platform === "win32") {
    throw new Error(
      "Windows builds require TECTONIC_DEP_BACKEND=vcpkg and VCPKG_ROOT. Install the Tectonic ports with a windows-static-md triplet.",
    );
  }
  if (
    process.platform === "darwin" &&
    environment.TECTONIC_DEP_BACKEND === "pkg-config"
  ) {
    const brew = spawnSync("brew", ["--prefix"], {
      encoding: "utf8",
      env: environment,
    });
    if (brew.status === 0) {
      const prefix = brew.stdout.trim();
      const prefixes = [prefix];
      for (const formula of [
        "icu4c",
        "harfbuzz",
        "freetype",
        "graphite2",
        "fontconfig",
      ]) {
        const result = spawnSync("brew", ["--prefix", formula], {
          encoding: "utf8",
          env: environment,
        });
        if (result.status === 0) prefixes.push(result.stdout.trim());
      }
      prependPaths(
        "PKG_CONFIG_PATH",
        prefixes.map((item) => path.join(item, "lib/pkgconfig")),
      );
      prependPaths(
        "CPATH",
        prefixes.map((item) => path.join(item, "include")),
      );
      prependPaths(
        "LIBRARY_PATH",
        prefixes.map((item) => path.join(item, "lib")),
      );
    }
  }
  console.log(
    `Building native helper with ${environment.TECTONIC_DEP_BACKEND}`,
  );
}

function linkedLibraries(file) {
  return run("otool", ["-L", file], true)
    .split("\n")
    .slice(1)
    .map((line) => line.trim().match(/^(.*?)\s+\(compatibility version /)?.[1])
    .filter(Boolean);
}

function libraryId(file) {
  return run("otool", ["-D", file], true).split("\n")[1]?.trim();
}

function runPaths(file) {
  const lines = run("otool", ["-l", file], true).split("\n");
  const paths = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== "cmd LC_RPATH") continue;
    const value = lines[index + 2]?.trim().match(/^path (.*?) \(offset /)?.[1];
    if (value) paths.push(value);
  }
  return paths;
}

function isSystemLibrary(file) {
  return file.startsWith("/usr/lib/") || file.startsWith("/System/Library/");
}

function bundleMacLibraries(sourceExecutable, packagedExecutable) {
  const librariesDir = path.join(destination, "lib");
  const copies = new Map();
  const names = new Map();
  const executableDir = path.dirname(sourceExecutable);
  mkdirSync(librariesDir, { recursive: true });

  function expandLoaderPath(value, source) {
    return value
      .replace(/^@loader_path(?=\/|$)/, path.dirname(source))
      .replace(/^@executable_path(?=\/|$)/, executableDir);
  }

  function resolveLibrary(reference, source, paths) {
    const candidates = reference.startsWith("@rpath/")
      ? paths.map((item) => path.join(item, reference.slice("@rpath/".length)))
      : [expandLoaderPath(reference, source)];
    const found = candidates.find(
      (candidate) => path.isAbsolute(candidate) && existsSync(candidate),
    );
    if (!found)
      throw new Error(`Cannot resolve ${reference} required by ${source}`);
    return realpathSync(found);
  }

  function copyDependencies(source, packaged, inheritedPaths) {
    const originalPaths = runPaths(source);
    const paths = [
      ...originalPaths.map((item) => expandLoaderPath(item, source)),
      ...inheritedPaths,
    ];
    const ownId = libraryId(source);
    for (const reference of linkedLibraries(source)) {
      if (reference === ownId || isSystemLibrary(reference)) continue;
      const resolved = resolveLibrary(reference, source, paths);
      let copied = copies.get(resolved);
      if (!copied) {
        const name = path.basename(reference);
        if (names.has(name) && names.get(name) !== resolved) {
          throw new Error(
            `Two native libraries have the same filename: ${name}`,
          );
        }
        copied = path.join(librariesDir, name);
        copies.set(resolved, copied);
        names.set(name, resolved);
        copyFileSync(resolved, copied);
        chmodSync(copied, 0o755);
        copyDependencies(resolved, copied, paths);
        run("install_name_tool", ["-id", `@rpath/${name}`, copied]);
      }
      const relative = path
        .relative(path.dirname(packaged), copied)
        .split(path.sep)
        .join("/");
      run("install_name_tool", [
        "-change",
        reference,
        `@loader_path/${relative}`,
        packaged,
      ]);
    }
    // Every non-system dependency now has a direct, relative loader path.
    for (const item of new Set(originalPaths)) {
      run("install_name_tool", ["-delete_rpath", item, packaged]);
    }
  }

  copyDependencies(sourceExecutable, packagedExecutable, []);
  const files = [...copies.values(), packagedExecutable];
  for (const file of files) {
    const ownId = libraryId(file);
    for (const reference of linkedLibraries(file)) {
      if (reference === ownId || isSystemLibrary(reference)) continue;
      const resolved = expandLoaderPath(reference, file);
      if (!reference.startsWith("@loader_path/") || !existsSync(resolved)) {
        throw new Error(
          `Packaged helper still has an external dependency: ${reference}`,
        );
      }
    }
    // install_name_tool invalidates existing signatures. Ad-hoc signing makes
    // local Apple Silicon builds runnable; release packaging signs them again.
    run("codesign", ["--force", "--sign", "-", file]);
  }
  console.log(`Bundled ${copies.size} native macOS libraries`);
}

try {
  configureDependencies();
  // Use the same native library environment for unit/integration tests and the
  // release build. In particular, Homebrew headers and pkg-config must agree.
  if (runTests) {
    run("cargo", ["test", "--manifest-path", manifest, "--locked"]);
  }
  const metadata = JSON.parse(
    run(
      "cargo",
      [
        "metadata",
        "--manifest-path",
        manifest,
        "--no-deps",
        "--format-version",
        "1",
      ],
      true,
    ),
  );
  run("cargo", ["build", "--manifest-path", manifest, "--release", "--locked"]);
  const executable = `${branding.namespace}-desktop${process.platform === "win32" ? ".exe" : ""}`;
  const source = path.join(
    metadata.target_directory,
    environment.CARGO_BUILD_TARGET ?? "",
    "release",
    executable,
  );
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const packaged = path.join(destination, executable);
  copyFileSync(source, packaged);
  if (process.platform !== "win32") chmodSync(packaged, 0o755);
  if (process.platform === "darwin") bundleMacLibraries(source, packaged);
  console.log(`Native helper ready: ${packaged}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
