import { describe, expect, it } from "vitest";
import { EXTERNAL_TEMPLATE_SOURCES } from "@/lib/new-project-resources";

describe("new project resources", () => {
  it("uses unique secure links from publishers and open archives", () => {
    const ids = EXTERNAL_TEMPLATE_SOURCES.map((source) => source.id);
    const urls = EXTERNAL_TEMPLATE_SOURCES.map((source) => source.url);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.every((url) => url.startsWith("https://"))).toBe(true);
  });

  it("keeps Overleaf guidance in-app instead of linking without permission", () => {
    expect(
      EXTERNAL_TEMPLATE_SOURCES.every(
        (source) => !source.url.includes("overleaf.com"),
      ),
    ).toBe(true);
  });

  it("includes dedicated conference and journal directories", () => {
    expect(
      EXTERNAL_TEMPLATE_SOURCES.some(
        (source) => source.url === "https://ctan.org/topic/confproc",
      ),
    ).toBe(true);
    expect(
      EXTERNAL_TEMPLATE_SOURCES.some(
        (source) => source.url === "https://ctan.org/topic/journalpub",
      ),
    ).toBe(true);
  });
});
