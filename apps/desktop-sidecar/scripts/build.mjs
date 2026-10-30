import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputPath = path.join(packageDir, "dist/index.mjs");

await build({
  absWorkingDir: packageDir,
  entryPoints: ["src/index.ts"],
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "inline",
  // Bundled CommonJS dependencies still require Node built-ins at runtime.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});

console.log(`Built Claude bridge: ${path.relative(packageDir, outputPath)}`);
