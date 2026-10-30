import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import {
  compileLatex,
  compileErrorDiagnostics,
  formatCompileError,
  type CompileDiagnostic,
} from "./latex-compiler";

vi.mock("@/stores/document-store", () => ({ resolveTexRoot: vi.fn() }));
vi.mock("@/lib/desktop/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (value: CompileDiagnostic[]) => void) {}
    dispose() {}
  },
}));

describe("compileLatex diagnostic transport", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("waits for diagnostics even when the binary PDF arrives first", async () => {
    let deliver!: (value: CompileDiagnostic[]) => void;
    const bytes = new Uint8Array([37, 80, 68, 70]);
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      deliver = (args as { diagnostics: { onmessage: typeof deliver } })
        .diagnostics.onmessage;
      return bytes.buffer;
    });
    let settled = false;
    const result = compileLatex("/project", "main.tex").then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    const diagnostics: CompileDiagnostic[] = [
      { severity: "warning", message: "Undefined reference" },
    ];
    deliver(diagnostics);
    await expect(result).resolves.toEqual({ pdfData: bytes, diagnostics });
  });

  it("keeps a native snapshot descriptor instead of expanding it into PDF bytes", async () => {
    const snapshot = {
      kind: "file",
      id: "snapshot",
      url: "catalex-asset://pdf/snapshot",
      byteLength: 1024 * 1024 * 1024,
    };
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      (
        args as {
          diagnostics: { onmessage: (value: CompileDiagnostic[]) => void };
        }
      ).diagnostics.onmessage([]);
      return snapshot;
    });
    const result = await compileLatex("/project");
    expect(result.pdfData).toBe(snapshot);
  });

  it("preserves structured locations when compilation fails before a PDF exists", async () => {
    const error = {
      message: "Compilation failed",
      diagnostics: [
        {
          severity: "error",
          message: "Undefined command",
          file: "child.tex",
          line: 12,
        },
      ],
    };
    vi.mocked(invoke).mockRejectedValue(error);
    await expect(compileLatex("/project")).rejects.toBe(error);
    expect(formatCompileError(error)).toBe("Compilation failed");
    expect(compileErrorDiagnostics(error)).toEqual(error.diagnostics);
  });

  it("accepts a clean result with no diagnostics", async () => {
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      (
        args as {
          diagnostics: { onmessage: (value: CompileDiagnostic[]) => void };
        }
      ).diagnostics.onmessage([]);
      return new ArrayBuffer(0);
    });
    await expect(compileLatex("/project")).resolves.toEqual({
      pdfData: new Uint8Array(),
      diagnostics: [],
    });
  });

  it("passes Auto through to native resolution while keeping manual engines explicit", async () => {
    vi.mocked(invoke).mockRejectedValue("stop after inspecting request");
    await compileLatex(
      "/project",
      "main.tex",
      "latexmk",
      "pdflatex",
      true,
    ).catch(() => {});
    expect(invoke).toHaveBeenLastCalledWith(
      "compile_latex",
      expect.objectContaining({ engine: null }),
    );
    await compileLatex("/project", "main.tex", "latexmk", "pdflatex").catch(
      () => {},
    );
    expect(invoke).toHaveBeenLastCalledWith(
      "compile_latex",
      expect.objectContaining({ engine: "pdflatex" }),
    );
  });

  it("rejects a failed compile without waiting for a diagnostic channel message", async () => {
    vi.mocked(invoke).mockRejectedValue("Compilation failed");
    await expect(compileLatex("/project")).rejects.toBe("Compilation failed");
  });
});
