import { invoke } from "@/lib/desktop/core";
import { readFile, writeFile } from "@/lib/desktop/fs";

export interface PdfFileSource {
  kind: "file";
  id: string;
  url: string;
  byteLength: number;
}
export type PdfSource = Uint8Array | PdfFileSource;

// Sources can be shared by live/history viewers, the document cache and undo
// state. Collect only after all JS owners are gone. Native leases additionally
// protect active worker streams; window close/startup removes abandoned files.
const collected = new FinalizationRegistry<string>((id) => {
  void invoke("desktop:pdf:release", { id }).catch(() => {});
});
export function trackPdfSource(source: PdfFileSource): PdfFileSource {
  collected.register(source, source.id);
  return source;
}
export async function openPdfSource(path: string): Promise<PdfSource> {
  if (!window.catalex) return readFile(path);
  return trackPdfSource(
    await invoke<PdfFileSource>("desktop:pdf:open", { path }),
  );
}
export async function exportPdfSource(source: PdfSource, path: string) {
  if (source instanceof Uint8Array) return writeFile(path, source);
  return invoke("desktop:pdf:export", { id: source.id, path });
}
export function pdfOpenArgument(
  source: PdfSource,
): ArrayBuffer | PdfFileSource {
  return source instanceof Uint8Array
    ? (source.slice().buffer as ArrayBuffer)
    : source;
}
