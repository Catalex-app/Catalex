import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = resolve(__dirname, "../../..");
const publicRoot = resolve(desktopRoot, "public");
const nativeIconPath = resolve(desktopRoot, "build/icons/icon.png");

describe("browser brand icon", () => {
  it("uses the generated Catalex app icon and has no legacy Prism assets", () => {
    const indexHtml = readFileSync(resolve(desktopRoot, "index.html"), "utf8");

    expect(indexHtml).toContain(
      '<link rel="icon" type="image/png" href="/favicon.png" />',
    );
    expect(readFileSync(resolve(publicRoot, "favicon.png"))).toEqual(
      readFileSync(nativeIconPath),
    );
    expect(existsSync(resolve(publicRoot, "favicon.ico"))).toBe(false);
    expect(existsSync(resolve(publicRoot, "icon-192.png"))).toBe(false);
  });
});
