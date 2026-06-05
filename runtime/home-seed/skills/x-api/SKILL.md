---
name: x-api
description: "Use X (Twitter) through Stella's connected account."
---

# X (Twitter) API via Stella

Use this skill when the user wants Stella to read from or act on their X/Twitter account.

Stella owns the X OAuth app and stores the user's X tokens on the backend. Do not ask the user for X API keys, client IDs, or client secrets. Do not use or inspect `~/.xurl`.

Use the first-party `stella-x-api` CLI. It is auto-injected into Stella shell commands and receives Stella auth from the runtime.

## Setup

Check connection status:

```bash
stella-x-api status
```

If X is not connected, generate a Stella connect URL:

```bash
stella-x-api connect
```

Open the returned URL for the user, or give it to the user to approve in their browser. After approval, rerun:

```bash
stella-x-api status
stella-x-api whoami --json
```

## Common Commands

```bash
# Current connected X account
stella-x-api whoami --json

# Post
stella-x-api post "Hello from Stella"

# Read a post by ID or URL
stella-x-api read 1234567890
stella-x-api read https://x.com/user/status/1234567890

# Search recent public posts
stella-x-api search "from:XDevelopers API" -n 10

# Raw X API v2 request
stella-x-api request /2/users/me --query '{"user.fields":"id,name,username,description,public_metrics"}'

# Raw POST
stella-x-api request /2/tweets --method POST --body '{"text":"Hello from Stella"}'
```

All command responses are JSON except `status` and `connect` without `--json`.

## Raw API Rules

- Use only X API v2 paths through `stella-x-api request`, such as `/2/users/me`, `/2/tweets/search/recent`, or `/2/tweets`.
- Do not pass authorization headers. Stella injects the connected user's OAuth token server-side.
- Prefer `--query` for query parameters and `--body` for JSON request bodies.
- Use `--json` on `connect` or `status` when downstream parsing matters.

## Current Limitations

- Media upload is not part of the first `stella-x-api` surface. For posts with media, ask whether a text-only post is acceptable or use another approved media flow if one exists.
- The helper targets X API v2 on `api.x.com`; it does not expose arbitrary hosts.
- If the backend returns that X is not connected or expired, run `stella-x-api connect` and have the user re-approve.

## Safety

- Never ask for, print, or store X API keys, client IDs, client secrets, access tokens, refresh tokens, or bearer tokens.
- Never inspect `~/.xurl`; it is unrelated to Stella's managed X connection and may contain live tokens from other tools.
- Confirm before posting, replying, deleting, sending DMs, following, blocking, muting, or otherwise taking account-changing actions.
