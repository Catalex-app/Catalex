import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import topLevelAwait from "vite-plugin-top-level-await";
import path from "node:path";
import fs from "node:fs";
import { demoLatex } from "./dev/demo-latex";
import { buildDocumentCore } from "../../scripts/build-document-core.mjs";

buildDocumentCore();
const branding = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../branding.json"), "utf8"),
);
const htmlProductName = branding.productName.replace(
  /[&<>"']/g,
  (char: string) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
      char
    ],
);

const rootPackageJsonPath = path.resolve(__dirname, "../../package.json");
const rootPackageVersion =
  JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8")).version ?? "0.0.0";

export default defineConfig({
  plugins: [
    react(),
    demoLatex(),
    {
      name: "app-branding",
      transformIndexHtml: (html) =>
        html.replaceAll("__APP_PRODUCT_NAME__", htmlProductName),
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/renderer"),
    },
  },
  worker: {
    // Only MuPDF needs top-level await. Transforming app chunks delays shared
    // exports and can break synchronous initialization in UI dependencies.
    plugins: () => [topLevelAwait()],
    format: "es",
  },
  optimizeDeps: {
    exclude: ["mupdf"],
  },
  esbuild: {
    supported: { "top-level-await": true },
  },
  clearScreen: false,
  server: {
    port: 14220,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      ignored: ["**/backend/**", "**/dist/**", "**/release/**"],
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(rootPackageVersion),
  },
  build: {
    // Dictionaries are fetched by a worker under the desktop content policy.
    assetsInlineLimit: (file) =>
      /\.(aff|dic)$/.test(file) ? false : undefined,
    outDir: "dist/renderer",
    target: "chrome140",
    minify: "esbuild",
  },
});
