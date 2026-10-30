import { mergeConfig } from "vite";
import { resolve } from "node:path";
import config from "./vite.config";

export default mergeConfig(config, {
  build: {
    outDir: "dist/performance",
    rollupOptions: { input: resolve(__dirname, "dev/typing-performance.html") },
  },
});
