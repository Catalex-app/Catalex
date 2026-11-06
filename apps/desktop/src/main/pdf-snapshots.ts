import { ASSET_PROTOCOL } from "../branding";
import fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

interface Snapshot {
  owner: string;
  path: string;
  size: number;
  released: boolean;
  leases: Set<string>;
}

/** Immutable disk snapshots; neither opening nor reading allocates a whole PDF. */
export class PdfSnapshots {
  private entries = new Map<string, Snapshot>();
  private leases = new Map<string, string>();
  private ready?: Promise<void>;
  private epochs = new Map<string, number>();
  constructor(private directory: string) {}

  private init() {
    return (this.ready ??= (async () => {
      // This directory belongs to the locked Electron profile, not project data.
      await fs.rm(this.directory, { recursive: true, force: true });
      await fs.mkdir(this.directory, { recursive: true });
    })());
  }

  async create(owner: string, write: (destination: string) => Promise<void>) {
    const epoch = this.epochs.get(owner) ?? 0;
    await this.init();
    const id = randomUUID();
    const destination = path.join(this.directory, `${id}.pdf`);
    try {
      await write(destination);
      const handle = await fs.open(destination, "r");
      let size: number;
      try {
        size = (await handle.stat()).size;
        const header = Buffer.alloc(5);
        await handle.read(header, 0, 5, 0);
        if (header.toString() !== "%PDF-")
          throw new Error("Invalid PDF header");
      } finally {
        await handle.close();
      }
      if ((this.epochs.get(owner) ?? 0) !== epoch)
        throw new Error("PDF owner closed");
      const hash = createHash("sha1");
      for await (const chunk of createReadStream(destination))
        hash.update(chunk);
      const fingerprint = hash.digest("hex");
      if ((this.epochs.get(owner) ?? 0) !== epoch)
        throw new Error("PDF owner closed");
      this.entries.set(id, {
        owner,
        path: destination,
        size,
        released: false,
        leases: new Set(),
      });
      return {
        kind: "file" as const,
        id,
        byteLength: size,
        fingerprint,
        url: `${ASSET_PROTOCOL}://pdf/${id}`,
      };
    } catch (error) {
      await fs.rm(destination, { force: true });
      throw error;
    }
  }

  copy(owner: string, source: string) {
    return this.create(owner, (destination) =>
      fs.copyFile(source, destination, constants.COPYFILE_FICLONE),
    );
  }

  private owned(owner: string, id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner || entry.released)
      throw new Error("PDF snapshot unavailable");
    return entry;
  }

  async export(owner: string, id: string, destination: string) {
    const entry = this.owned(owner, id);
    const lease = randomUUID();
    entry.leases.add(lease);
    try {
      await fs.copyFile(entry.path, destination);
    } finally {
      entry.leases.delete(lease);
      await this.collect(id, entry);
    }
  }

  async release(owner: string, id: string) {
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return;
    entry.released = true;
    await this.collect(id, entry);
  }

  private async collect(id: string, entry: Snapshot) {
    if (!entry.released || entry.leases.size) return;
    this.entries.delete(id);
    await fs.rm(entry.path, { force: true });
  }

  async closeWindow(owner: string) {
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    for (const [id, entry] of this.entries) {
      if (entry.owner !== owner) continue;
      for (const lease of entry.leases) this.leases.delete(lease);
      entry.leases.clear();
      entry.released = true;
      await this.collect(id, entry);
    }
  }

  async respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [id, action] = url.pathname.slice(1).split("/");
    if (action === "lease" && request.method === "POST") {
      const entry = this.entries.get(id);
      if (!entry || entry.released) return new Response(null, { status: 404 });
      const lease = randomUUID();
      entry.leases.add(lease);
      this.leases.set(lease, id);
      return new Response(lease);
    }
    const snapshotId = this.leases.get(id);
    const entry = snapshotId && this.entries.get(snapshotId);
    if (!entry) return new Response(null, { status: 404 });
    if (request.method === "DELETE") {
      this.leases.delete(id);
      entry.leases.delete(id);
      await this.collect(snapshotId, entry);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const offset = Number(url.searchParams.get("offset"));
    const length = Number(url.searchParams.get("length"));
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 1 ||
      length > 1024 * 1024 ||
      offset + length > entry.size
    )
      return new Response(null, { status: 416 });
    const handle = await fs.open(entry.path, "r");
    try {
      const bytes = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(
          bytes,
          read,
          length - read,
          offset + read,
        );
        if (!result.bytesRead)
          throw new Error("Unexpected end of PDF snapshot");
        read += result.bytesRead;
      }
      return new Response(bytes, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
        },
      });
    } finally {
      await handle.close();
    }
  }
}
