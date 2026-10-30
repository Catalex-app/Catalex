import { describe, expect, it } from "vitest";
import { RENDERER_CSP } from "./security";

const directives = new Map(
  RENDERER_CSP.split(";").map((directive) => {
    const [name, ...sources] = directive.trim().split(/\s+/);
    return [name, sources];
  }),
);

describe("packaged renderer content policy", () => {
  it("allows CodeMirror runtime styles without nonce rules that disable them", () => {
    const styles = directives.get("style-src")!;
    expect(styles).toContain("'unsafe-inline'");
    expect(styles.some((source) => source.startsWith("'nonce-"))).toBe(false);
  });

  it("allows MuPDF WebAssembly while forbidding inline scripts and JavaScript eval", () => {
    expect(directives.get("script-src")).toEqual([
      "'self'",
      "'wasm-unsafe-eval'",
    ]);
    expect(directives.get("worker-src")).toEqual(["'self'", "blob:"]);
  });

  it("allows local theme fonts, embedded fonts and trusted Google fonts", () => {
    expect(directives.get("font-src")).toEqual(
      expect.arrayContaining([
        "'self'",
        "catalex-asset:",
        "data:",
        "https://fonts.gstatic.com",
      ]),
    );
    expect(directives.get("style-src")).toContain(
      "https://fonts.googleapis.com",
    );
  });

  it("limits image and frame content to app resources, local assets and blobs", () => {
    expect(directives.get("img-src")).toEqual([
      "'self'",
      "catalex-asset:",
      "data:",
      "blob:",
    ]);
    expect(directives.get("frame-src")).toEqual(["'self'", "blob:"]);
    expect(directives.get("default-src")).toEqual(["'self'"]);
  });

  it("permits required data services without allowing arbitrary network origins", () => {
    const connections = directives.get("connect-src")!;
    expect(connections).toEqual(
      expect.arrayContaining([
        "catalex-asset:",
        "https://api.zotero.org",
        "https://ccfddl.github.io",
        "https://ccfddl.com",
      ]),
    );
    for (const unrestricted of ["*", "http:", "https:", "file:", "ipc:"]) {
      expect(connections).not.toContain(unrestricted);
    }
  });
});
