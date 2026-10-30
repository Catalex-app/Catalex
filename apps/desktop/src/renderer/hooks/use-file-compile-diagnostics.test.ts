import { expect, it, vi } from "vitest";
import { selectFileCompileDiagnostics } from "./use-file-compile-diagnostics";
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: vi.fn(),
  resolveTexRoot: vi.fn(),
}));

it("shows included-file diagnostics on that file and general messages on the root", () => {
  const root = {
    severity: "warning" as const,
    message: "Root",
    file: "main.tex",
    line: 3,
  };
  const child = {
    severity: "error" as const,
    message: "Child",
    file: "sections/child.tex",
    line: 4,
  };
  const general = { severity: "warning" as const, message: "Global" };
  const external = {
    severity: "warning" as const,
    message: "Package",
    file: "/texlive/package.sty",
    line: 8,
  };
  const cache = new Map([["main.tex", [root, child, general, external]]]);
  const files = new Set(["main.tex", "sections/child.tex"]);
  expect(
    selectFileCompileDiagnostics(
      "main.tex",
      "main.tex",
      files,
      cache,
      new Map(),
    ),
  ).toEqual([root, general, external]);
  expect(
    selectFileCompileDiagnostics(
      "sections/child.tex",
      "main.tex",
      files,
      cache,
      new Map(),
    ),
  ).toEqual([child]);
});

it("retains located failures without replacing them with the generic build error", () => {
  const failure = {
    severity: "error" as const,
    message: "Undefined command",
    file: "main.tex",
    line: 4,
  };
  expect(
    selectFileCompileDiagnostics(
      "main.tex",
      "main.tex",
      new Set(["main.tex"]),
      new Map([["main.tex", [failure]]]),
      new Map([["main.tex", "Compilation failed"]]),
    ),
  ).toEqual([failure]);
});

it("shows a locationless failure only on its compilation root", () => {
  const errors = new Map([["main.tex", "Engine unavailable"]]);
  expect(
    selectFileCompileDiagnostics(
      "main.tex",
      "main.tex",
      new Set(),
      new Map(),
      errors,
    ),
  ).toEqual([{ severity: "error", message: "Engine unavailable" }]);
  expect(
    selectFileCompileDiagnostics(
      "child.tex",
      "main.tex",
      new Set(),
      new Map(),
      errors,
    ),
  ).toEqual([]);
});
