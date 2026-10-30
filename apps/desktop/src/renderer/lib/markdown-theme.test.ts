import { configDir } from "@/lib/desktop/path";
import { exists, readDir } from "@/lib/desktop/fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  externalMarkdownThemeId,
  detectDefaultTyporaThemeDirectory,
  defaultTyporaThemeDirectoryCandidates,
  listMarkdownThemes,
  pathFromExternalMarkdownThemeId,
  resolveMarkdownThemeDirectory,
  rewriteExternalMarkdownThemeAssetUrls,
} from "./markdown-theme";

describe("Markdown theme folders", () => {
  beforeEach(() => {
    vi.mocked(configDir).mockReset();
    vi.mocked(exists).mockReset();
    vi.mocked(readDir).mockReset();
  });

  it("finds the platform Typora folder under the OS config directory", async () => {
    vi.mocked(configDir).mockResolvedValue(
      "/Users/me/Library/Application Support",
    );
    vi.mocked(exists).mockImplementation(
      async (path) =>
        path ===
        "/Users/me/Library/Application Support/abnerworks.Typora/themes",
    );

    expect(
      defaultTyporaThemeDirectoryCandidates(
        "/Users/me/Library/Application Support",
      ),
    ).toEqual([
      "/Users/me/Library/Application Support/abnerworks.Typora/themes",
      "/Users/me/Library/Application Support/Typora/themes",
    ]);
    await expect(detectDefaultTyporaThemeDirectory()).resolves.toBe(
      "/Users/me/Library/Application Support/abnerworks.Typora/themes",
    );
  });

  it("falls back to the Windows and Linux Typora directory name", async () => {
    vi.mocked(configDir).mockResolvedValue("/home/me/.config");
    vi.mocked(exists).mockImplementation(
      async (path) => path === "/home/me/.config/Typora/themes",
    );

    await expect(detectDefaultTyporaThemeDirectory()).resolves.toBe(
      "/home/me/.config/Typora/themes",
    );
  });

  it("uses a configured override without probing the OS default", async () => {
    await expect(resolveMarkdownThemeDirectory("/themes/custom")).resolves.toBe(
      "/themes/custom",
    );
    expect(configDir).not.toHaveBeenCalled();
  });

  it("lists top-level Typora CSS files in label order", async () => {
    vi.mocked(readDir).mockResolvedValue([
      {
        name: "night.css",
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      },
      {
        name: "assets",
        isFile: false,
        isDirectory: true,
        isSymlink: false,
      },
      {
        name: "Academic.CSS",
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      },
    ]);

    await expect(listMarkdownThemes("/themes")).resolves.toEqual([
      {
        fileName: "Academic.CSS",
        label: "Academic",
        path: "/themes/Academic.CSS",
      },
      {
        fileName: "night.css",
        label: "night",
        path: "/themes/night.css",
      },
    ]);
  });

  it("round-trips external theme IDs without confusing project files", () => {
    const path = "/themes/academic.css";
    expect(pathFromExternalMarkdownThemeId(externalMarkdownThemeId(path))).toBe(
      path,
    );
    expect(pathFromExternalMarkdownThemeId("project:academic.css")).toBeNull();
  });

  it("rewrites relative Typora assets beside the selected stylesheet", () => {
    const css = `
      @font-face { src: url("./academic/font.woff2?#iefix"); }
      body { background: url(../shared/paper.png); }
      a { cursor: url(https://example.com/cursor.cur), auto; }
    `;

    const rewritten = rewriteExternalMarkdownThemeAssetUrls(
      css,
      "/Users/me/.config/Typora/themes/academic.css",
      (path) => `asset://${path}`,
    );

    expect(rewritten).toContain(
      'url("asset:///Users/me/.config/Typora/themes/academic/font.woff2?#iefix")',
    );
    expect(rewritten).toContain(
      'url("asset:///Users/me/.config/Typora/shared/paper.png")',
    );
    expect(rewritten).toContain("url(https://example.com/cursor.cur)");
  });
});
