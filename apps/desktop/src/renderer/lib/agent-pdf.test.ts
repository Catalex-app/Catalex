import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "./desktop/core";
import { useDocumentStore } from "@/stores/document-store";
import { getMupdfClient } from "./mupdf/mupdf-client";
import { readAgentPdf } from "./agent-pdf";

vi.mock("./mupdf/mupdf-client", async () => ({
  ...(await vi.importActual<typeof import("./mupdf/mupdf-client")>(
    "./mupdf/mupdf-client",
  )),
  getMupdfClient: vi.fn(),
}));
const request = {
  requestId: "request",
  projectRoot: "/project",
  path: "/project/paper.pdf",
  fingerprint: "a".repeat(40),
  pages: [1],
};
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(getMupdfClient).mockReset();
  useDocumentStore.setState({ projectRoot: "/project" });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "desktop:pdf:open"
      ? { kind: "file", id: "owned", fingerprint: request.fingerprint }
      : undefined,
  );
});
it("does not read another project or an outdated binary and releases stale snapshots", async () => {
  await expect(
    readAgentPdf({ ...request, projectRoot: "/other" }),
  ).rejects.toThrow("stale_session");
  expect(invoke).not.toHaveBeenCalled();
  await expect(
    readAgentPdf({ ...request, fingerprint: "b".repeat(40) }),
  ).rejects.toThrow("changed_pdf");
  expect(getMupdfClient).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenLastCalledWith("desktop:pdf:release", {
    id: "owned",
  });
});
it("releases its snapshot if the worker cannot start", async () => {
  vi.mocked(getMupdfClient).mockImplementation(() => {
    throw new Error("worker failed");
  });
  await expect(readAgentPdf(request)).rejects.toThrow("worker failed");
  expect(invoke).toHaveBeenLastCalledWith("desktop:pdf:release", {
    id: "owned",
  });
});
it("closes the private document and snapshot when page extraction fails", async () => {
  const closeDocument = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getMupdfClient).mockReturnValue({
    openDocument: vi.fn().mockResolvedValue(42),
    countPages: vi.fn().mockResolvedValue(1),
    getPageText: vi.fn().mockRejectedValue(new Error("bad page")),
    closeDocument,
  } as unknown as ReturnType<typeof getMupdfClient>);
  await expect(readAgentPdf(request)).rejects.toThrow("bad page");
  expect(closeDocument).toHaveBeenCalledWith(42);
  expect(invoke).toHaveBeenLastCalledWith("desktop:pdf:release", {
    id: "owned",
  });
});
