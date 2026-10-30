import { describe, expect, it } from "vitest";
import {
  getDefaultExternalEditorId,
  sortExternalEditorsByName,
  type EditorInfo,
} from "./external-app-selector";

const editors = (...items: Array<Pick<EditorInfo, "id" | "name">>) =>
  items.map((item) => ({ ...item }));

describe("external app selector helpers", () => {
  it("defaults to Finder when it is available", () => {
    expect(
      getDefaultExternalEditorId(
        editors(
          { id: "cursor", name: "Cursor" },
          { id: "finder", name: "Finder" },
          { id: "vscode", name: "VS Code" },
        ),
      ),
    ).toBe("finder");
  });

  it("falls back to the first detected editor when Finder is unavailable", () => {
    expect(
      getDefaultExternalEditorId(
        editors(
          { id: "cursor", name: "Cursor" },
          { id: "vscode", name: "VS Code" },
        ),
      ),
    ).toBe("cursor");
  });

  it("sorts the Open In menu alphabetically by app name", () => {
    expect(
      sortExternalEditorsByName(
        editors(
          { id: "zed", name: "Zed" },
          { id: "finder", name: "Finder" },
          { id: "cursor", name: "Cursor" },
          { id: "vscode", name: "VS Code" },
        ),
      ).map((editor) => editor.name),
    ).toEqual(["Cursor", "Finder", "VS Code", "Zed"]);
  });
});
