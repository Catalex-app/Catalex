import { describe, expect, it } from "vitest";
import { reconcileFile } from "./external-file-changes";
import type { ProjectFile } from "@/stores/document-store";

const file: ProjectFile = {
  id: "a.json",
  relativePath: "a.json",
  absolutePath: "/project/a.json",
  name: "a.json",
  type: "other",
  content: "base",
  isDirty: false,
};
describe("external file reconciliation", () => {
  it("refreshes clean JSON and ignores repeated notifications", () => {
    const refreshed = reconcileFile(file, "disk");
    expect(refreshed).toMatchObject({
      content: "disk",
      isDirty: false,
      diskContent: "disk",
    });
    expect(reconcileFile(refreshed, "disk")).toBe(refreshed);
  });
  it("keeps the base, local text and disk version separate", () => {
    const local = {
      ...file,
      diskContent: "base",
      content: "local",
      isDirty: true,
    };
    expect(reconcileFile(local, "base")).toBe(local);
    const conflict = reconcileFile(local, "external");
    expect(conflict.content).toBe("local");
    expect(conflict.externalChange).toMatchObject({
      base: "base",
      disk: "external",
    });
    expect(reconcileFile(conflict, "external")).toBe(conflict);
  });
  it("preserves review edits if the disk changes again", () => {
    const conflict = reconcileFile(
      { ...file, diskContent: "base", content: "local", isDirty: true },
      "external",
    );
    const updated = reconcileFile(
      {
        ...conflict,
        externalChange: {
          ...conflict.externalChange!,
          reviewContent: "reviewed",
        },
      },
      "new external",
    );
    expect(updated.content).toBe("reviewed");
    expect(updated.externalChange).toMatchObject({
      base: "base",
      disk: "new external",
    });
    expect(updated.externalChange?.id).not.toBe(conflict.externalChange?.id);
  });
  it("retains text after deletion and recovers clean atomic replacements", () => {
    const missing = reconcileFile(file, null);
    expect(missing.content).toBe("base");
    expect(missing.externalChange?.disk).toBeNull();
    expect(reconcileFile(missing, "replacement")).toMatchObject({
      content: "replacement",
      isDirty: false,
      externalChange: undefined,
    });
  });
});
