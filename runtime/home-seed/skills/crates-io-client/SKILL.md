---
name: crates-io-client
description: Look up Rust crates on crates.io — search, versions, downloads, repository links — without loading a browser. Use when picking or checking a Rust dependency.
---

# crates.io

Direct access to the API behind crates.io. No browser, no login.

```bash
bun ~/.stella/skills/crates-io-client/scripts/program.ts search <query> [flags]
bun ~/.stella/skills/crates-io-client/scripts/program.ts crate <name>
bun ~/.stella/skills/crates-io-client/scripts/program.ts versions <name> [--limit N]
```

## Commands

`search` finds crates by name and description:

- `--limit N` — results, max 100 (default 10)
- `--sort relevance|downloads|recent-downloads|new` — default `relevance`
- `--raw` — full response instead of the trimmed fields

Quote multi-word queries. Sort by `recent-downloads` to see what people are
actually using now rather than what accumulated downloads over a decade.

`crate <name>` returns the current version, description, links, categories and
the five most recent versions — the usual "should I use this dependency" view.

`versions <name>` lists release history with per-version download counts,
licenses and yank status. Use it to check whether a version was yanked or how
recently the crate has been maintained.

```bash
… search "async runtime" --sort recent-downloads --limit 5
… crate tokio
… versions serde --limit 20
```

## Reading the output

Output is JSON. `search` gives `total` plus `crates`, each with `name`,
`version`, `description`, `downloads`, `recentDownloads`, `updatedAt`,
`repository`, `documentation`. `crate` adds `categories` and `recentVersions`.

`downloads` is all-time and `recentDownloads` is roughly the last 90 days; a
large gap between them usually means a crate that peaked and faded.

## When it breaks

This client was derived from crates.io's own traffic on 2026-07-24. The
endpoints are the ones its frontend uses, not a documented contract. crates.io
asks automated clients to identify themselves, so the requests send a
descriptive user-agent — keep that if you edit this client, since anonymous
traffic gets rate-limited.

If calls start failing, re-derive with the `derive-site-api` skill rather than
guessing at the new shape.
