import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CATALEX_DEV_PORT = 14220;
const LOOPBACK_HOST = "127.0.0.1";

describe("desktop dev server ports", () => {
  const viteConfigPath = resolve(__dirname, "../../../vite.config.ts");
  const viteConfigText = readFileSync(viteConfigPath, "utf-8");
  const launcherText = readFileSync(
    resolve(__dirname, "../../../scripts/dev-electron.mjs"),
    "utf-8",
  );
  const expectedUrl = `http://${LOOPBACK_HOST}:${CATALEX_DEV_PORT}`;

  it("uses a fixed Catalex-specific Vite port", () => {
    expect(viteConfigText).toMatch(
      new RegExp(`server:\\s*{[\\s\\S]*port:\\s*${CATALEX_DEV_PORT},`),
    );
    expect(viteConfigText).toMatch(/strictPort:\s*true,/);
  });

  it("binds Vite and its Electron launcher to the same loopback address", () => {
    const viteHost = viteConfigText.match(
      /server:\s*\{[\s\S]*?host:\s*["']([^"']+)["']/,
    )?.[1];
    const launchHost = launcherText.match(
      /createServer\(\{[\s\S]*?server:\s*\{[^}]*?host:\s*["']([^"']+)["']/,
    )?.[1];
    const launchPort = launcherText.match(
      /createServer\(\{[\s\S]*?server:\s*\{[^}]*?port:\s*(\d+)/,
    )?.[1];
    expect(viteHost).toBe(LOOPBACK_HOST);
    expect(launchHost).toBe(viteHost);
    expect(Number(launchPort)).toBe(CATALEX_DEV_PORT);
  });

  it("waits for Vite to listen before Electron opens its URL", () => {
    const listenIndex = launcherText.search(/await\s+vite\.listen\(\)/);
    const spawnIndex = launcherText.search(/spawn\(electron,/);
    const rendererUrl = launcherText.match(
      /CATALEX_DEV_URL:\s*["']([^"']+)["']/,
    )?.[1];
    expect(listenIndex).toBeGreaterThanOrEqual(0);
    expect(spawnIndex).toBeGreaterThan(listenIndex);
    expect(rendererUrl).toBe(expectedUrl);
  });
});
