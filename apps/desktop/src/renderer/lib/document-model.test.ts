import { describe, expect, it } from "vitest";
import { DocumentModel } from "./document-model";

describe("shared native document model", () => {
  it("forks an immutable next state without mutating its parent", () => {
    const before = DocumentModel.open("text", [{ id: "a", from: 0, to: 4 }]);
    const after = before.fork([
      { type: "text", edits: [{ from: 0, to: 0, insert: "new " }] },
    ]);
    try {
      expect(before.snapshot()).toMatchObject({
        text: "text",
        revision: 0,
        anchors: [{ from: 0, to: 4 }],
      });
      expect(after.snapshot()).toMatchObject({
        text: "new text",
        revision: 1,
        anchors: [{ from: 4, to: 8 }],
      });
      before.dispose();
      expect(after.snapshot().text).toBe("new text");
    } finally {
      before.dispose();
      after.dispose();
    }
  });
  it("applies text and comment operations together without losing resolved anchors", () => {
    const model = DocumentModel.open("before selected after", [
      { id: "a", from: 7, to: 15 },
    ]);
    try {
      model.apply([
        { type: "text", edits: [{ from: 0, to: 0, insert: "😀 " }] },
        { type: "resolve", id: "a", resolved: true },
      ]);
      expect(model.snapshot()).toMatchObject({
        revision: 1,
        text: "😀 before selected after",
        anchors: [{ id: "a", from: 10, to: 18, resolved: true }],
      });
      const saved = model.snapshot();
      expect(() => model.apply([{ type: "removeAnchor", id: "a" }], 0)).toThrow(
        "Stale",
      );
      expect(model.snapshot()).toEqual(saved);
    } finally {
      model.dispose();
    }
  });

  it("does not partially publish an invalid operation batch", () => {
    const model = DocumentModel.open("😀 selected", [
      { id: "a", from: 3, to: 11 },
    ]);
    try {
      const before = model.snapshot();
      expect(() =>
        model.apply([
          { type: "resolve", id: "a", resolved: true },
          { type: "text", edits: [{ from: 1, to: 1, insert: "bad" }] },
        ]),
      ).toThrow("Invalid");
      expect(model.snapshot()).toEqual(before);
    } finally {
      model.dispose();
    }
  });

  it("rejects an old timeline after close and reopen", () => {
    const old = DocumentModel.open("old", []);
    old.dispose();
    const current = DocumentModel.open("new", []);
    try {
      expect(() =>
        old.apply([
          { type: "text", edits: [{ from: 0, to: 0, insert: "old update" }] },
        ]),
      ).toThrow("closed");
      expect(current.snapshot().text).toBe("new");
    } finally {
      current.dispose();
    }
  });
});
