import { parse, rcompare, gt } from "semver";
import type { ManualUpdate, UpdateCheckResult } from "../update-types";

const API = "https://api.github.com/repos/Catalex-app/Catalex/releases";
const RELEASES = "https://github.com/Catalex-app/Catalex/releases/tag/";
const CACHE_MS = 5 * 60_000;

interface GitHubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  body?: unknown;
  assets?: Array<{ name?: unknown; state?: unknown; size?: unknown }>;
}

class ReleaseCheckError extends Error {}

export class ReleaseUpdates {
  private cached: { result: UpdateCheckResult; expires: number } | null = null;
  private pending: Promise<UpdateCheckResult> | null = null;

  constructor(
    private readonly version: string,
    private readonly platform: string,
    private readonly arch: string,
    private readonly fetcher: (
      url: string,
      init: RequestInit,
    ) => Promise<Response>,
    private readonly timeoutMs = 15_000,
  ) {}

  check(force = false): Promise<UpdateCheckResult> {
    if (this.pending) return this.pending;
    if (!force && this.cached && this.cached.expires > Date.now())
      return Promise.resolve(this.cached.result);
    this.pending = this.load()
      .then((result) => {
        this.cached = {
          result,
          expires:
            Date.now() +
            (result && "unavailable" in result ? 60_000 : CACHE_MS),
        };
        return result;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private async load(): Promise<UpdateCheckResult> {
    const current = parse(this.version);
    if (!current)
      return {
        unavailable: true,
        message: "This build has no comparable release version.",
      };
    if (this.platform !== "darwin" || this.arch !== "arm64")
      return {
        unavailable: true,
        message:
          "Downloads are currently available for Apple Silicon Macs only.",
      };
    const includeBeta = current.prerelease.length > 0;
    const candidates: ManualUpdate[] = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let url: string | null = `${API}?per_page=100`;
    try {
      for (let page = 0; url && page < 10; page++) {
        const response: Response = await this.fetcher(url, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": `Catalex/${this.version}`,
          },
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
        if (response.status === 404)
          return {
            unavailable: true,
            message:
              "Update checks are unavailable until the repository and releases are public.",
          };
        if (response.status === 403 || response.status === 429)
          throw new ReleaseCheckError(
            "GitHub update checks are temporarily limited. Try again later.",
          );
        if (!response.ok)
          throw new ReleaseCheckError(
            "Could not check GitHub for updates. Try again later.",
          );
        const releases: unknown = await response.json();
        if (!Array.isArray(releases))
          throw new ReleaseCheckError(
            "GitHub returned an invalid release list.",
          );
        for (const entry of releases) {
          if (!entry || typeof entry !== "object") continue;
          const release = entry as GitHubRelease;
          if (release.draft !== false || typeof release.tag_name !== "string")
            continue;
          const version = parse(release.tag_name);
          if (!version || !gt(version, current)) continue;
          if (!includeBeta && (release.prerelease || version.prerelease.length))
            continue;
          if (version.prerelease.length && version.prerelease[0] !== "beta")
            continue;
          if (
            !Array.isArray(release.assets) ||
            !release.assets.some(
              (asset) =>
                asset &&
                asset.name === `Catalex-${version.version}-arm64.dmg` &&
                asset.state === "uploaded" &&
                typeof asset.size === "number" &&
                asset.size > 0,
            )
          )
            continue;
          candidates.push({
            mode: "manual",
            version: version.version,
            body: typeof release.body === "string" ? release.body : undefined,
            releaseUrl: `${RELEASES}${encodeURIComponent(release.tag_name)}`,
          });
        }
        const next: string | undefined = response.headers
          .get("link")
          ?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
        url = null;
        if (next) {
          const target: URL = new URL(next);
          if (
            target.origin !== "https://api.github.com" ||
            target.pathname !== new URL(API).pathname ||
            target.username ||
            target.password
          )
            throw new ReleaseCheckError(
              "GitHub returned an invalid release page.",
            );
          url = target.href;
        }
      }
      if (url)
        throw new ReleaseCheckError(
          "Could not finish checking release history. Try again later.",
        );
      candidates.sort((a, b) => rcompare(a.version, b.version));
      return candidates[0] ?? null;
    } catch (error) {
      if (controller.signal.aborted)
        throw new ReleaseCheckError(
          "The update check timed out. Try again when you are online.",
        );
      if (error instanceof ReleaseCheckError) throw error;
      if (error instanceof SyntaxError)
        throw new ReleaseCheckError("GitHub returned an invalid release list.");
      throw new ReleaseCheckError(
        "Could not reach GitHub. Check your connection and try again.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
