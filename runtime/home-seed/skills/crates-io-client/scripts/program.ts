#!/usr/bin/env bun
/**
 * crates.io client, derived from the site's own network traffic.
 *
 * Endpoints were recorded from crates.io on 2026-07-24 with derive-site-api.
 * They are the API the site's frontend uses; they are not a documented contract
 * and can change without notice. `--raw` exists for when the trimmed output
 * hides something you need.
 *
 * Usage:
 *   bun program.ts search <query> [--limit N] [--sort relevance|downloads|recent-downloads|new]
 *   bun program.ts crate <name>
 *   bun program.ts versions <name> [--limit N]
 */

export {};

const BASE = "https://crates.io/api/v1";
// crates.io asks automated clients to identify themselves; an honest UA is the
// difference between working and being rate-limited.
const HEADERS = {
  accept: "application/json",
  "user-agent": "stella-crates-io-client (https://github.com/anthropics/stella)",
};

const args = process.argv.slice(2);
const command = args[0];

/** Flags that consume the following token; everything else is a bare switch. */
const VALUE_FLAGS = new Set(["limit", "sort"]);
const parsedFlags = new Map<string, string>();
const positional: string[] = [];
for (let index = 1; index < args.length; index += 1) {
  const token = args[index];
  if (!token.startsWith("--")) {
    positional.push(token);
    continue;
  }
  const name = token.slice(2);
  // Without this, a flag's value is silently swept into the positional list and
  // becomes part of the search query.
  if (VALUE_FLAGS.has(name)) {
    parsedFlags.set(name, args[index + 1] ?? "");
    index += 1;
  } else {
    parsedFlags.set(name, "true");
  }
}
const flag = (name: string): string | undefined => parsedFlags.get(name);
const hasFlag = (name: string): boolean => parsedFlags.has(name);

const limit = Number(flag("limit") ?? 10);
const raw = hasFlag("raw");

const die = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const get = async (path: string): Promise<any> => {
  const response = await fetch(`${BASE}${path}`, { headers: HEADERS });
  const text = await response.text();
  if (!response.ok) {
    // Surface the body: it distinguishes "no such crate" from a moved endpoint,
    // which is what tells you whether the client needs re-deriving.
    die(`crates.io returned ${response.status} for ${path}\n${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return die(`crates.io returned non-JSON for ${path} (${text.length} bytes)`);
  }
};

const emit = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

const trimCrate = (c: any) => ({
  name: c.name,
  version: c.newest_version ?? c.default_version ?? c.max_version,
  description: c.description,
  downloads: c.downloads,
  recentDownloads: c.recent_downloads,
  updatedAt: c.updated_at,
  homepage: c.homepage,
  repository: c.repository,
  documentation: c.documentation,
  keywords: c.keywords ?? undefined,
});

switch (command) {
  case "search": {
    const query = positional.join(" ");
    if (!query) die("usage: search <query> [--limit N] [--sort ...]");
    const sort = flag("sort") ?? "relevance";
    const params = new URLSearchParams({
      q: query,
      page: "1",
      per_page: String(Math.min(limit, 100)),
      sort,
    });
    const data = await get(`/crates?${params}`);
    emit(
      raw
        ? data
        : {
            total: data.meta?.total,
            crates: (data.crates ?? []).map(trimCrate),
          },
    );
    break;
  }

  case "crate": {
    const name = positional[0];
    if (!name) die("usage: crate <name>");
    const data = await get(`/crates/${encodeURIComponent(name)}`);
    emit(
      raw
        ? data
        : {
            ...trimCrate(data.crate ?? {}),
            categories: (data.categories ?? []).map((c: any) => c.category),
            recentVersions: (data.versions ?? []).slice(0, 5).map((v: any) => ({
              num: v.num,
              createdAt: v.created_at,
              downloads: v.downloads,
              yanked: v.yanked,
              rustVersion: v.rust_version ?? undefined,
            })),
          },
    );
    break;
  }

  case "versions": {
    const name = positional[0];
    if (!name) die("usage: versions <name> [--limit N]");
    const data = await get(`/crates/${encodeURIComponent(name)}/versions`);
    const versions = (data.versions ?? []).slice(0, limit);
    emit(
      raw
        ? data
        : versions.map((v: any) => ({
            num: v.num,
            createdAt: v.created_at,
            downloads: v.downloads,
            yanked: v.yanked,
            license: v.license,
          })),
    );
    break;
  }

  default:
    die(
      "usage:\n" +
        "  bun program.ts search <query> [--limit N] [--sort relevance|downloads|recent-downloads|new]\n" +
        "  bun program.ts crate <name>\n" +
        "  bun program.ts versions <name> [--limit N]\n" +
        "Add --raw to print the untrimmed response.",
    );
}
