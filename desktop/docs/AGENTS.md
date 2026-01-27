# Agents

Agents are instruction sets that define a system prompt, tool preferences, and delegation limits.

Agents live on disk at:

- `~/.stellar/agents/<agentId>/AGENT.md`

## `AGENT.md` format

Use YAML frontmatter followed by Markdown instructions.

```md
---
id: coder
name: Coder
agentTypes: [general]
description: Implements and tests changes.
toolsAllowlist: [Read, Write, Edit, Grep, Bash, Task, TaskOutput]
defaultSkills: [typescript, testing]
maxTaskDepth: 2
version: 1
---

You are a careful implementation agent...
```

## Sync behavior

The local host scans `~/.stellar/agents` and syncs manifests to the backend via `agents.upsertMany`.

Built-in agents (`general`, `self_mod`) are always ensured server-side.

## Skills
A skill is a set of local instructions stored in a `SKILL.md` file. Below is the list of skills available in this workspace. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.

### Available skills
- 1password: Set up and use 1Password CLI (op). Use when installing the CLI, enabling desktop app integration, signing in (single or multi-account), or reading/injecting/running secrets via op. (file: skills/1password/SKILL.md)
- apple-notes: Manage Apple Notes via the `memo` CLI on macOS (create, view, edit, delete, search, move, and export notes). Use when a user asks Clawdbot to add a note, list notes, search notes, or manage note folders. (file: skills/apple-notes/SKILL.md)
- apple-reminders: Manage Apple Reminders via the `remindctl` CLI on macOS (list, add, edit, complete, delete). Supports lists, date filters, and JSON/plain output. (file: skills/apple-reminders/SKILL.md)
- bear-notes: Create, search, and manage Bear notes via grizzly CLI. (file: skills/bear-notes/SKILL.md)
- bird: X/Twitter CLI for reading, searching, posting, and engagement via cookies. (file: skills/bird/SKILL.md)
- blogwatcher: Monitor blogs and RSS/Atom feeds for updates using the blogwatcher CLI. (file: skills/blogwatcher/SKILL.md)
- blucli: BluOS CLI (blu) for discovery, playback, grouping, and volume. (file: skills/blucli/SKILL.md)
- bluebubbles: Build or update the BlueBubbles external channel plugin for Clawdbot (extension package, REST send/probe, webhook inbound). (file: skills/bluebubbles/SKILL.md)
- camsnap: Capture frames or clips from RTSP/ONVIF cameras. (file: skills/camsnap/SKILL.md)
- clawdhub: Use the ClawdHub CLI to search, install, update, and publish agent skills from clawdhub.com. Use when you need to fetch new skills on the fly, sync installed skills to latest or a specific version, or publish new/updated skill folders with the npm-installed clawdhub CLI. (file: skills/clawdhub/SKILL.md)
- coding-agent: Run Codex CLI, Claude Code, OpenCode, or Pi Coding Agent via background process for programmatic control. (file: skills/coding-agent/SKILL.md)
- discord: Use when you need to control Discord from Clawdbot via the discord tool: send messages, react, post or upload stickers, upload emojis, run polls, manage threads/pins/search, create/edit/delete channels and categories, fetch permissions or member/role/channel info, or handle moderation actions in Discord DMs or channels. (file: skills/discord/SKILL.md)
- eightctl: Control Eight Sleep pods (status, temperature, alarms, schedules). (file: skills/eightctl/SKILL.md)
- food-order: Reorder Foodora orders + track ETA/status with ordercli. Never confirm without explicit user approval. Triggers: order food, reorder, track ETA. (file: skills/food-order/SKILL.md)
- gemini: Gemini CLI for one-shot Q&A, summaries, and generation. (file: skills/gemini/SKILL.md)
- gifgrep: Search GIF providers with CLI/TUI, download results, and extract stills/sheets. (file: skills/gifgrep/SKILL.md)
- github: "Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries." (file: skills/github/SKILL.md)
- gog: Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs. (file: skills/gog/SKILL.md)
- goplaces: Query Google Places API (New) via the goplaces CLI for text search, place details, resolve, and reviews. Use for human-friendly place lookup or JSON output for scripts. (file: skills/goplaces/SKILL.md)
- himalaya: "CLI to manage emails via IMAP/SMTP. Use `himalaya` to list, read, write, reply, forward, search, and organize emails from the terminal. Supports multiple accounts and message composition with MML (MIME Meta Language)." (file: skills/himalaya/SKILL.md)
- imsg: iMessage/SMS CLI for listing chats, history, watch, and sending. (file: skills/imsg/SKILL.md)
- local-places: Search for places (restaurants, cafes, etc.) via Google Places API proxy on localhost. (file: skills/local-places/SKILL.md)
- mcporter: Use the mcporter CLI to list, configure, auth, and call MCP servers/tools directly (HTTP or stdio), including ad-hoc servers, config edits, and CLI/type generation. (file: skills/mcporter/SKILL.md)
- model-usage: Use CodexBar CLI local cost usage to summarize per-model usage for Codex or Claude, including the current (most recent) model or a full model breakdown. Trigger when asked for model-level usage/cost data from codexbar, or when you need a scriptable per-model summary from codexbar cost JSON. (file: skills/model-usage/SKILL.md)
- nano-banana-pro: Generate or edit images via Gemini 3 Pro Image (Nano Banana Pro). (file: skills/nano-banana-pro/SKILL.md)
- nano-pdf: Edit PDFs with natural-language instructions using the nano-pdf CLI. (file: skills/nano-pdf/SKILL.md)
- notion: Notion API for creating and managing pages, databases, and blocks. (file: skills/notion/SKILL.md)
- obsidian: Work with Obsidian vaults (plain Markdown notes) and automate via obsidian-cli. (file: skills/obsidian/SKILL.md)
- openai-image-gen: Batch-generate images via OpenAI Images API. Random prompt sampler + `index.html` gallery. (file: skills/openai-image-gen/SKILL.md)
- openai-whisper: Local speech-to-text with the Whisper CLI (no API key). (file: skills/openai-whisper/SKILL.md)
- openai-whisper-api: Transcribe audio via OpenAI Audio Transcriptions API (Whisper). (file: skills/openai-whisper-api/SKILL.md)
- openhue: Control Philips Hue lights/scenes via the OpenHue CLI. (file: skills/openhue/SKILL.md)
- oracle: Best practices for using the oracle CLI (prompt + file bundling, engines, sessions, and file attachment patterns). (file: skills/oracle/SKILL.md)
- ordercli: Foodora-only CLI for checking past orders and active order status (Deliveroo WIP). (file: skills/ordercli/SKILL.md)
- peekaboo: Capture and automate macOS UI with the Peekaboo CLI. (file: skills/peekaboo/SKILL.md)
- prose: OpenProse VM skill pack. Activate on any `prose` command, .prose files, or OpenProse mentions; orchestrates multi-agent workflows. (file: extensions/open-prose/skills/prose/SKILL.md)
- sag: ElevenLabs text-to-speech with mac-style say UX. (file: skills/sag/SKILL.md)
- session-logs: Search and analyze your own session logs (older/parent conversations) using jq. (file: skills/session-logs/SKILL.md)
- sherpa-onnx-tts: Local text-to-speech via sherpa-onnx (offline, no cloud) (file: skills/sherpa-onnx-tts/SKILL.md)
- skill-creator: Create or update AgentSkills. Use when designing, structuring, or packaging skills with scripts, references, and assets. (file: skills/skill-creator/SKILL.md)
- slack: Use when you need to control Slack from Clawdbot via the slack tool, including reacting to messages or pinning/unpinning items in Slack channels or DMs. (file: skills/slack/SKILL.md)
- songsee: Generate spectrograms and feature-panel visualizations from audio with the songsee CLI. (file: skills/songsee/SKILL.md)
- sonoscli: Control Sonos speakers (discover/status/play/volume/group). (file: skills/sonoscli/SKILL.md)
- spotify-player: Terminal Spotify playback/search via spogo (preferred) or spotify_player. (file: skills/spotify-player/SKILL.md)
- summarize: Summarize or extract text/transcripts from URLs, podcasts, and local files (great fallback for "transcribe this YouTube/video"). (file: skills/summarize/SKILL.md)
- things-mac: Manage Things 3 via the `things` CLI on macOS (add/update projects+todos via URL scheme; read/search/list from the local Things database). Use when a user asks Clawdbot to add a task to Things, list inbox/today/upcoming, search tasks, or inspect projects/areas/tags. (file: skills/things-mac/SKILL.md)
- tmux: Remote-control tmux sessions for interactive CLIs by sending keystrokes and scraping pane output. (file: skills/tmux/SKILL.md)
- trello: Manage Trello boards, lists, and cards via the Trello REST API. (file: skills/trello/SKILL.md)
- video-frames: Extract frames or short clips from videos using ffmpeg. (file: skills/video-frames/SKILL.md)
- voice-call: Start voice calls via the Clawdbot voice-call plugin. (file: skills/voice-call/SKILL.md)
- wacli: Send WhatsApp messages to other people or search/sync WhatsApp history via the wacli CLI (not for normal user chats). (file: skills/wacli/SKILL.md)
- weather: Get current weather and forecasts (no API key required). (file: skills/weather/SKILL.md)
