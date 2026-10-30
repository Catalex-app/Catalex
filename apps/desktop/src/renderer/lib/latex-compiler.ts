import {
  trackPdfSource,
  type PdfSource,
  type PdfFileSource,
} from "./mupdf/pdf-source";
import { useSettingsStore } from "@/stores/settings-store";
import { Channel, invoke } from "@/lib/desktop/core";
import { resolveTexRoot, type ProjectFile } from "@/stores/document-store";
import type {
  CompilerBackend,
  ConcreteCompilerEngine,
} from "@/stores/settings-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("latex");

function hasHiddenDirectory(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -1).some((part) => part.startsWith("."));
}

/** Resolve which file to compile and the root ID for caching.
 *  resolveTexRoot now handles \documentclass detection and main.tex fallback,
 *  so the only remaining fallback here is for projects with no .tex files.
 *  Returns `null` when the project has no compilable .tex file. */
export function resolveCompileTarget(
  activeFileId: string,
  files: ProjectFile[],
): { rootId: string; targetPath: string } | null {
  const rootId = resolveTexRoot(activeFileId, files);
  const rootEntry = files.find((f) => f.id === rootId);
  if (
    rootEntry?.type === "tex" &&
    !hasHiddenDirectory(rootEntry.relativePath)
  ) {
    return { rootId, targetPath: rootEntry.relativePath };
  }
  // No .tex file exists — cannot compile
  const anyTex = files.find(
    (f) => f.type === "tex" && !hasHiddenDirectory(f.relativePath),
  );
  if (anyTex) {
    return { rootId: anyTex.id, targetPath: anyTex.relativePath };
  }
  return null;
}

export function detectTexEngineFromContent(
  content: string,
): ConcreteCompilerEngine | null {
  for (const line of content.split("\n", 20)) {
    const match = line.match(/^%\s*!TEX\s+program\s*=\s*(\S+)/i);
    const engine = match?.[1]?.toLowerCase();
    if (engine === "latex" || engine === "pdflatex") return "pdflatex";
    if (engine === "xelatex") return "xelatex";
    if (engine === "lualatex") return "lualatex";
  }
  return null;
}

/** Extract a human-readable error message from an unknown catch value. */
export function formatCompileError(error: unknown): string {
  return error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : typeof error === "string"
      ? error
      : "Compilation failed";
}

export interface CompileDiagnostic {
  severity: "warning" | "error";
  message: string;
  file?: string | null;
  line?: number | null;
  end_line?: number | null;
}

export function compileErrorDiagnostics(error: unknown): CompileDiagnostic[] {
  if (
    !error ||
    typeof error !== "object" ||
    !("diagnostics" in error) ||
    !Array.isArray(error.diagnostics)
  )
    return [];
  return error.diagnostics.filter(
    (item): item is CompileDiagnostic =>
      item &&
      typeof item.message === "string" &&
      (item.severity === "error" || item.severity === "warning"),
  );
}

export interface CompileResult {
  pdfData: PdfSource;
  diagnostics: CompileDiagnostic[];
}

export async function compileLatex(
  projectDir: string,
  mainFile: string = "main.tex",
  backend: CompilerBackend = "latexmk",
  engine: ConcreteCompilerEngine = "pdflatex",
  autoEngine = false,
): Promise<CompileResult> {
  log.info(`Compiling ${mainFile} (backend: ${backend}, engine: ${engine})`);
  const start = performance.now();
  // Compiler diagnostics arrive separately from the PDF response.
  let receiveDiagnostics!: (value: CompileDiagnostic[]) => void;
  const diagnosticsResult = new Promise<CompileDiagnostic[]>((resolve) => {
    receiveDiagnostics = resolve;
  });
  const diagnostics = new Channel<CompileDiagnostic[]>(receiveDiagnostics);
  try {
    const buffer = await invoke<
      ArrayBuffer | Uint8Array | number[] | PdfFileSource
    >(window.catalex ? "compile_latex_snapshot" : "compile_latex", {
      projectDir,
      mainFile,
      backend,
      engine: autoEngine ? null : engine,
      diagnostics,
      installation: useSettingsStore.getState().latexInstallation,
    });

    const result =
      "kind" in buffer && buffer.kind === "file"
        ? trackPdfSource(buffer)
        : buffer instanceof Uint8Array
          ? buffer
          : new Uint8Array(buffer as ArrayBuffer);
    log.info(
      `Compiled ${mainFile} in ${(performance.now() - start).toFixed(0)}ms (${(result.byteLength / 1024).toFixed(0)} KB)`,
    );
    return { pdfData: result, diagnostics: await diagnosticsResult };
  } finally {
    diagnostics.dispose();
  }
}

export interface LatexInstallation {
  id: string;
  name: string;
  version: string | null;
  engines: string[];
  binaryPaths: Record<string, string>;
  available: boolean;
}

export interface TexliveStatus {
  installations?: LatexInstallation[];
  available: boolean;
  engines: string[];
  latexmkAvailable: boolean;
  binaryPaths?: Record<string, string>;
  version: string | null;
}

export async function detectTexlive(): Promise<TexliveStatus> {
  return invoke<TexliveStatus>("detect_texlive");
}

export interface SynctexSourceMap {
  inputs: Record<number, string>;
  boxes: Array<{
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    sources: Array<{ tag: number; line: number }>;
  }>;
}

export async function getSynctexSourceMap(
  projectDir: string,
): Promise<SynctexSourceMap | null> {
  try {
    return await invoke<SynctexSourceMap>("get_synctex_source_map", {
      projectDir,
    });
  } catch (err) {
    log.debug("SyncTeX source map unavailable", { error: String(err) });
    return null;
  }
}

export interface SynctexResult {
  file: string;
  line: number;
  column: number;
}

export interface SynctexViewResult {
  page: number;
  x: number;
  y: number;
}

export async function synctexEdit(
  projectDir: string,
  page: number,
  x: number,
  y: number,
): Promise<SynctexResult | null> {
  try {
    const result = await invoke<SynctexResult>("synctex_edit", {
      projectDir,
      page,
      x,
      y,
    });
    if (result)
      log.debug(`SyncTeX: page ${page} → ${result.file}:${result.line}`);
    return result;
  } catch (err) {
    log.debug("SyncTeX lookup failed", { page, error: String(err) });
    return null;
  }
}

export async function synctexView(
  projectDir: string,
  file: string,
  line: number,
  column: number,
): Promise<SynctexViewResult | null> {
  try {
    const result = await invoke<SynctexViewResult>("synctex_view", {
      projectDir,
      file,
      line,
      column,
    });
    if (result) log.debug(`SyncTeX: ${file}:${line} → page ${result.page}`);
    return result;
  } catch (err) {
    log.debug("SyncTeX view lookup failed", {
      file,
      line,
      error: String(err),
    });
    return null;
  }
}
