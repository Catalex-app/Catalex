import { describe, expect, it, vi } from "vitest";
import { ReleaseUpdates } from "./release-updates";

function release(version: string, overrides = {}) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes("-"),
    body: "Release notes",
    assets: [
      { name: `Catalex-${version}-arm64.dmg`, state: "uploaded", size: 123 },
    ],
    ...overrides,
  };
}
function response(data: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), { headers });
}
function setup(data: unknown, version = "0.1.0-beta") {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
    response(data),
  );
  return {
    fetcher,
    updates: new ReleaseUpdates(version, "darwin", "arm64", fetcher),
  };
}

describe("GitHub release update checks", () => {
  it("selects the greatest installable version rather than API order or Latest designation", async () => {
    const { updates } = setup([
      release("0.1.1-beta"),
      release("0.1.10-beta"),
      release("0.1.2-beta"),
      release("9.0.0-beta", { draft: true }),
      release("1.0.0-alpha"),
      release("8.0.0-beta", { assets: [] }),
      release("not-a-version"),
      release("7.0.0-beta", {
        assets: [
          { name: "Catalex-7.0.0-beta-arm64.dmg", size: 123, state: "starter" },
        ],
      }),
    ]);
    expect(await updates.check()).toMatchObject({
      mode: "manual",
      version: "0.1.10-beta",
      releaseUrl:
        "https://github.com/Catalex-app/Catalex/releases/tag/v0.1.10-beta",
    });
  });
  it("keeps stable users on stable releases and promotes beta users to a newer stable release", async () => {
    const data = [
      release("0.2.0-beta"),
      release("0.1.1"),
      release("0.1.2", { prerelease: true }),
    ];
    expect(await setup(data, "0.1.0").updates.check()).toMatchObject({
      version: "0.1.1",
    });
    expect(
      await setup([release("0.1.0"), release("0.1.0-beta")]).updates.check(),
    ).toMatchObject({ version: "0.1.0" });
    expect(
      await setup([release("0.1.0-beta"), release("0.0.9")]).updates.check(),
    ).toBeNull();
  });
  it.each([
    ["0.1.0-beta", ["0.1.1-beta"], "0.1.1-beta"],
    ["0.1.0-beta", ["0.1.0-beta.1"], "0.1.0-beta.1"],
    ["0.1.0-beta.2", ["0.1.0-beta.9", "0.1.0-beta.10"], "0.1.0-beta.10"],
    ["0.1.0-beta", ["0.1.0"], "0.1.0"],
    ["0.1.1-beta", ["0.1.0", "0.1.1"], "0.1.1"],
    ["0.1.0", ["0.1.1-beta", "0.1.0", "0.0.9"], null],
    ["0.1.1", ["0.1.0-beta", "0.1.0", "0.1.1"], null],
    ["0.1.0-beta", ["0.1.1-beta", "0.1.1"], "0.1.1"],
  ])("routes installed %s through the release progression", async (current, versions, expected) => {
    const result = await setup(
      versions.map((version) => release(version)),
      current,
    ).updates.check();
    if (expected) expect(result).toMatchObject({ version: expected });
    else expect(result).toBeNull();
  });
  it("ignores wrong-platform, misnamed, empty, and incomplete installers", async () => {
    const unusable = [
      { name: "Catalex-0.2.0-arm64.dmg", state: "uploaded", size: 0 },
      { name: "Catalex-0.2.0-x64.dmg", state: "uploaded", size: 123 },
      { name: "Catalex-0.2.0-arm64.zip", state: "uploaded", size: 123 },
      { name: "Catalex-0.2.0-arm64.dmg", state: "starter", size: 123 },
      { name: "Catalex-0.1.9-arm64.dmg", state: "uploaded", size: 123 },
    ];
    for (const asset of unusable) {
      expect(
        await setup([
          release("0.2.0", { assets: [asset] }),
          release("0.1.1-beta"),
        ]).updates.check(),
      ).toMatchObject({ version: "0.1.1-beta" });
    }
  });
  it("walks all linked pages and constructs the release URL from the trusted repository", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
      response([]),
    );
    fetcher.mockResolvedValueOnce(
      response([release("0.1.1-beta")], {
        link: '<https://api.github.com/repos/Catalex-app/Catalex/releases?page=2>; rel="next"',
      }),
    );
    fetcher.mockResolvedValueOnce(
      response([
        release("0.2.0-beta", { html_url: "https://example.com/untrusted" }),
      ]),
    );
    const updates = new ReleaseUpdates(
      "0.1.0-beta",
      "darwin",
      "arm64",
      fetcher,
    );
    expect(await updates.check()).toMatchObject({
      version: "0.2.0-beta",
      releaseUrl:
        "https://github.com/Catalex-app/Catalex/releases/tag/v0.2.0-beta",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: "omit",
      redirect: "error",
    });
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty(
      "Authorization",
    );
  });
  it("rejects unexpected pagination destinations and incomplete history", async () => {
    for (const url of [
      "https://example.com/releases",
      "https://api.github.com/user",
      "https://secret@api.github.com/repos/Catalex-app/Catalex/releases",
    ]) {
      const fetcher = vi.fn(async () =>
        response([], { link: `<${url}>; rel="next"` }),
      );
      await expect(
        new ReleaseUpdates("0.1.0-beta", "darwin", "arm64", fetcher).check(),
      ).rejects.toThrow("invalid release page");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn(async () =>
      response([release("0.1.1-beta")], {
        link: '<https://api.github.com/repos/Catalex-app/Catalex/releases?page=2>; rel="next"',
      }),
    );
    await expect(
      new ReleaseUpdates("0.1.0-beta", "darwin", "arm64", fetcher).check(),
    ).rejects.toThrow("finish checking release history");
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
  it("deduplicates simultaneous checks, caches successful results, and allows explicit rechecks", async () => {
    const { updates, fetcher } = setup([release("0.1.1-beta")]);
    await Promise.all([updates.check(), updates.check(true)]);
    await updates.check();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await updates.check(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("reports inaccessible repositories as unavailable rather than up to date", async () => {
    const fetcher = vi.fn(
      async () => new Response("Not found", { status: 404 }),
    );
    expect(
      await new ReleaseUpdates(
        "0.1.0-beta",
        "darwin",
        "arm64",
        fetcher,
      ).check(),
    ).toMatchObject({ unavailable: true });
  });
  it("handles rate limits, offline failures, and malformed responses without offering an update", async () => {
    for (const status of [403, 429]) {
      const fetcher = vi.fn(async () => new Response("Limited", { status }));
      await expect(
        new ReleaseUpdates("0.1.0-beta", "darwin", "arm64", fetcher).check(),
      ).rejects.toThrow("temporarily limited");
    }
    for (const error of [
      new TypeError("Network unavailable"),
      new Error("net::ERR_INTERNET_DISCONNECTED"),
    ]) {
      const offline = vi.fn(async () => {
        throw error;
      });
      await expect(
        new ReleaseUpdates("0.1.0-beta", "darwin", "arm64", offline).check(),
      ).rejects.toThrow("connection");
    }
    await expect(
      new ReleaseUpdates(
        "0.1.0-beta",
        "darwin",
        "arm64",
        async () => new Response("bad JSON"),
      ).check(),
    ).rejects.toThrow("invalid release list");
    await expect(
      setup({ message: "Invalid data" }).updates.check(),
    ).rejects.toThrow("invalid release list");
  });
  it("times out stalled requests and can retry", async () => {
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const updates = new ReleaseUpdates(
      "0.1.0-beta",
      "darwin",
      "arm64",
      fetcher,
      10,
    );
    await expect(updates.check()).rejects.toThrow("timed out");
    fetcher.mockImplementation(async () => response([]));
    expect(await updates.check()).toBeNull();
  });
  it("does not offer incompatible installers or compare invalid local versions", async () => {
    const fetcher = vi.fn(async () => response([]));
    expect(
      await new ReleaseUpdates("0.1.0-beta", "darwin", "x64", fetcher).check(),
    ).toMatchObject({ unavailable: true });
    expect(
      await new ReleaseUpdates(
        "development",
        "darwin",
        "arm64",
        fetcher,
      ).check(),
    ).toMatchObject({ unavailable: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
