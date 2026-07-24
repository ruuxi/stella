#!/usr/bin/env bun
/**
 * Hacker News client, derived from hn.algolia.com's own network traffic.
 *
 * Recorded on 2026-07-24 with derive-site-api. The search index is the same
 * one the HN Search page queries; the application id and search key below were
 * observed in that traffic and are public per-index search credentials, not
 * user secrets. They are not a documented contract and can change.
 *
 * Usage:
 *   bun program.ts search <query> [--limit N] [--sort relevance|date]
 *                                 [--type story|comment|all] [--min-points N] [--since YYYY-MM-DD]
 *   bun program.ts front [--limit N]
 *   bun program.ts item <id>
 */

const APP_ID = "UJ5WYC0L7X";
const SEARCH_KEY = "28f0e1ec37a5e792e6845e67da5f20dd";
const HOST = `https://${APP_ID.toLowerCase()}-dsn.algolia.net`;
const INDEX_BY_SORT = { relevance: "Item_dev", date: "Item_dev_sort_date" } as const;

const args = process.argv.slice(2);
const command = args[0];

/** Flags that consume the following token; everything else is a bare switch. */
const VALUE_FLAGS = new Set(["limit", "sort", "type", "min-points", "since"]);
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

const limit = Math.min(Number(flag("limit") ?? 20), 100);
const raw = hasFlag("raw");

const die = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const query = async (index: string, body: Record<string, unknown>): Promise<any> => {
  const params = new URLSearchParams({
    "x-algolia-api-key": SEARCH_KEY,
    "x-algolia-application-id": APP_ID,
  });
  const response = await fetch(`${HOST}/1/indexes/${index}/query?${params}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    // The body names the cause — an expired key reads very differently from a
    // renamed index, and that distinction decides whether to re-record.
    die(`Algolia returned ${response.status}\n${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return die(`Algolia returned non-JSON (${text.length} bytes)`);
  }
};

const emit = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

const trimHit = (hit: any) => ({
  id: hit.objectID,
  title: hit.title ?? hit.story_title,
  url: hit.url ?? hit.story_url,
  author: hit.author,
  points: hit.points,
  comments: hit.num_comments,
  createdAt: hit.created_at,
  discussion: `https://news.ycombinator.com/item?id=${hit.story_id ?? hit.objectID}`,
  ...(hit.comment_text ? { comment: String(hit.comment_text).slice(0, 400) } : {}),
});

const buildFilters = (): string[][] => {
  const type = flag("type") ?? "story";
  if (type === "all") return [];
  return [[type]];
};

const numericFilters = (): string[] => {
  const filters: string[] = [];
  const minPoints = flag("min-points");
  if (minPoints) filters.push(`points>=${Number(minPoints)}`);
  const since = flag("since");
  if (since) {
    const stamp = Math.floor(new Date(since).getTime() / 1000);
    if (!Number.isFinite(stamp)) die(`--since must be a date, got ${since}`);
    filters.push(`created_at_i>=${stamp}`);
  }
  return filters;
};

switch (command) {
  case "search": {
    const text = positional.join(" ");
    if (!text) die("usage: search <query> [--limit N] [--sort relevance|date] ...");
    const sort = (flag("sort") ?? "relevance") as keyof typeof INDEX_BY_SORT;
    const index = INDEX_BY_SORT[sort];
    if (!index) die(`--sort must be relevance or date, got ${sort}`);

    const data = await query(index, {
      query: text,
      page: 0,
      hitsPerPage: limit,
      tagFilters: buildFilters(),
      numericFilters: numericFilters(),
      advancedSyntax: true,
    });
    emit(raw ? data : { total: data.nbHits, hits: (data.hits ?? []).map(trimHit) });
    break;
  }

  case "front": {
    // The front page is just "recent stories ranked by points" in the same index.
    const data = await query(INDEX_BY_SORT.date, {
      query: "",
      page: 0,
      hitsPerPage: limit,
      tagFilters: [["front_page"]],
    });
    emit(raw ? data : { hits: (data.hits ?? []).map(trimHit) });
    break;
  }

  case "item": {
    const id = positional[0];
    if (!id) die("usage: item <id>");
    const response = await fetch(`https://hn.algolia.com/api/v1/items/${encodeURIComponent(id)}`);
    const text = await response.text();
    if (!response.ok) die(`Algolia returned ${response.status}\n${text.slice(0, 500)}`);
    const data = JSON.parse(text);
    const flatten = (node: any, depth = 0): any[] =>
      node.text || node.title
        ? [
            {
              depth,
              author: node.author,
              text: node.text ? String(node.text).slice(0, 600) : node.title,
              points: node.points ?? undefined,
            },
            ...(node.children ?? []).flatMap((c: any) => flatten(c, depth + 1)),
          ]
        : (node.children ?? []).flatMap((c: any) => flatten(c, depth));
    emit(raw ? data : { id: data.id, title: data.title, url: data.url, thread: flatten(data) });
    break;
  }

  default:
    die(
      "usage:\n" +
        "  bun program.ts search <query> [--limit N] [--sort relevance|date] [--type story|comment|all] [--min-points N] [--since YYYY-MM-DD]\n" +
        "  bun program.ts front [--limit N]\n" +
        "  bun program.ts item <id>\n" +
        "Add --raw to print the untrimmed response.",
    );
}
