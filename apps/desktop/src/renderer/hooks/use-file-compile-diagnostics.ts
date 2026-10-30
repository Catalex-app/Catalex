import { createFilesSelector } from "@/lib/file-selectors";
import { useMemo } from "react";
import type { CompileDiagnostic } from "@/lib/latex-compiler";
import { resolveTexRoot, useDocumentStore } from "@/stores/document-store";

/** Source diagnostics belong to the input file, even when a root document was compiled. */
export function selectFileCompileDiagnostics(
  file: string,
  root: string,
  projectFiles: Set<string>,
  cache: Map<string, CompileDiagnostic[]>,
  errors: Map<string, string>,
): CompileDiagnostic[] {
  // Prefer the active document's compilation; support included style/bibliography files too.
  const results =
    cache.get(root) ??
    [...cache.values()].find((items) =>
      items.some((item) => item.file === file),
    );
  if (results?.length) {
    return results.filter(
      (diagnostic) =>
        diagnostic.file === file ||
        (file === root &&
          (!diagnostic.file || !projectFiles.has(diagnostic.file))),
    );
  }
  const error = file === root ? errors.get(root) : undefined;
  return error ? [{ severity: "error", message: error }] : [];
}

export function useFileCompileDiagnostics(fileId: string): CompileDiagnostic[] {
  const root = useDocumentStore(
    useMemo(
      () => createFilesSelector((files) => resolveTexRoot(fileId, files)),
      [fileId],
    ),
  );
  const paths = useDocumentStore(
    useMemo(
      () =>
        createFilesSelector((files) =>
          files.map((file) => file.relativePath).join("\n"),
        ),
      [],
    ),
  );
  const errors = useDocumentStore((state) => state.compileErrorCache);
  const cache = useDocumentStore((state) => state.compileDiagnosticsCache);
  return useMemo(
    () =>
      selectFileCompileDiagnostics(
        fileId,
        root,
        new Set(paths.split("\n")),
        cache,
        errors,
      ),
    [fileId, root, paths, cache, errors],
  );
}
