// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PdfSnapshots } from "./pdf-snapshots";

let root: string;
let snapshots: PdfSnapshots;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-snapshots-test-"));
  snapshots = new PdfSnapshots(path.join(root, "snapshots"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const request = (url: string, method = "GET") => new Request(url, { method });

describe("PDF disk snapshots", () => {
  it("keeps immutable bytes across replacement, protects worker leases, and releases disk files", async () => {
    const source = path.join(root, "original.pdf");
    await fs.writeFile(source, "%PDF-first version");
    const pdf = await snapshots.copy("window", source);
    await fs.writeFile(source, "%PDF-other version");
    const lease = await (
      await snapshots.respond(request(`${pdf.url}/lease`, "POST"))
    ).text();
    const url = `catalex-asset://pdf/${lease}`;
    expect(
      await (
        await snapshots.respond(request(`${url}?offset=5&length=5`))
      ).text(),
    ).toBe("first");
    await expect(
      snapshots.export("wrong", pdf.id, path.join(root, "bad.pdf")),
    ).rejects.toThrow();
    const destination = path.join(root, "export.pdf");
    await snapshots.export("window", pdf.id, destination);
    expect(await fs.readFile(destination, "utf8")).toBe("%PDF-first version");
    await snapshots.release("window", pdf.id);
    expect(
      (await snapshots.respond(request(`${pdf.url}/lease`, "POST"))).status,
    ).toBe(404);
    expect(
      (await snapshots.respond(request(`${url}?offset=0&length=5`))).status,
    ).toBe(200);
    await snapshots.respond(request(url, "DELETE"));
    expect(await fs.readdir(path.join(root, "snapshots"))).toEqual([]);
    expect(
      (await snapshots.respond(request(`${url}?offset=0&length=5`))).status,
    ).toBe(404);
  });
  it("bounds range allocations and removes snapshots on window reload", async () => {
    const pdf = await snapshots.create("window", (p) =>
      fs.writeFile(p, "%PDF-content"),
    );
    const lease = await (
      await snapshots.respond(request(`${pdf.url}/lease`, "POST"))
    ).text();
    for (const query of [
      "offset=-1&length=1",
      "offset=0&length=1048577",
      "offset=5&length=999",
      "offset=0.5&length=1",
    ])
      expect(
        (
          await snapshots.respond(
            request(`catalex-asset://pdf/${lease}?${query}`),
          )
        ).status,
      ).toBe(416);
    await snapshots.closeWindow("window");
    expect(await fs.readdir(path.join(root, "snapshots"))).toEqual([]);
  });
  it("removes a partial snapshot when compilation or copying fails", async () => {
    await expect(
      snapshots.create("window", async (destination) => {
        await fs.writeFile(destination, "partial output");
        throw new Error("Compilation failed");
      }),
    ).rejects.toThrow("Compilation failed");
    expect(await fs.readdir(path.join(root, "snapshots"))).toEqual([]);
  });
  it("does not publish a snapshot after its owner reloads during creation", async () => {
    await expect(
      snapshots.create("window", async (p) => {
        await fs.writeFile(p, "%PDF-content");
        await snapshots.closeWindow("window");
      }),
    ).rejects.toThrow("owner closed");
    expect(await fs.readdir(path.join(root, "snapshots"))).toEqual([]);
  });
});
