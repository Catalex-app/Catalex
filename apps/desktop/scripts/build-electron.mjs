import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: {
    "main/index": "src/main/index.ts",
    "main/chat-search-worker": "src/main/chat-search-worker.ts",
    "preload/index": "src/preload/index.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  platform: "node",
  target: "node22",
  format: "cjs",
  bundle: true,
  external: ["electron"],
  sourcemap: true,
});
