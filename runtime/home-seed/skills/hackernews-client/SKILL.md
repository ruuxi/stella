---
name: hackernews-client
description: Search and read Hacker News — stories, comments and threads — without loading a browser. Use for "what does HN say about X", finding discussions, or reading a thread.
---

# Hacker News

Direct access to the search index behind HN Search. No browser, no login, no
API key to configure.

```bash
bun ~/.stella/skills/hackernews-client/scripts/program.ts search <query> [flags]
bun ~/.stella/skills/hackernews-client/scripts/program.ts front [--limit N]
bun ~/.stella/skills/hackernews-client/scripts/program.ts item <id>
```

## Searching

`search` flags:

- `--limit N` — results, max 100 (default 20)
- `--sort relevance|date` — default `relevance`; use `date` for "what's being said now"
- `--type story|comment|all` — default `story`; use `comment` to search discussion text
- `--min-points N` — filter out low-signal noise; 100+ is a good bar for "notable"
- `--since YYYY-MM-DD` — only items after this date
- `--raw` — full response instead of the trimmed fields

Quote multi-word queries. Results carry a `discussion` URL for the HN thread.

```bash
# Notable discussion about a topic, recent first
… search "postgres performance" --sort date --min-points 100 --limit 10

# What people actually said, not just headlines
… search "rust borrow checker" --type comment --limit 20
```

`front` returns what is on the front page right now. `item <id>` returns a whole
thread flattened with a `depth` field per comment, which is usually what you
want for summarizing a discussion — take the id from a search result.

## Reading the output

Output is JSON. Stories give `title`, `url`, `author`, `points`, `comments`,
`createdAt`, `discussion`. Comments add a truncated `comment`. Thread entries
from `item` give `depth`, `author`, `text`.

Comment text is HTML-escaped as HN stores it (`&gt;` for quoted lines) and is
truncated — fetch with `--raw` if you need a comment in full.

## When it breaks

This client was derived from hn.algolia.com's own traffic on 2026-07-24; the
index names and search key are read from that recording, not from a documented
contract. If calls start failing, re-derive with the `derive-site-api` skill
rather than guessing: record hn.algolia.com, diff the endpoints, update this
client. A 403 usually means the search key rotated; a 404 means the index was
renamed.
