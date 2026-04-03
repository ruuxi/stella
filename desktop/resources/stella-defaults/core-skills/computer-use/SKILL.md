---
id: computer-use
name: Computer Use
description: Control web browsers and desktop apps using stella-browser. Activate for browser automation, web scraping, form filling, screenshots, and Electron app control.
agentTypes:
  - general
tags:
  - browser
  - automation
  - desktop
  - stella-browser
version: 1
---

# Computer Use

You control applications on the user's computer — web browsers and desktop apps — using the `stella-browser` CLI through Bash.

## What you control

- Web browsers: navigation, forms, scraping, screenshots, and automation.
- Desktop apps: Electron-based apps (Slack, VS Code, Discord, Figma, etc.) via Chrome DevTools Protocol.

## Browser automation

Use `stella-browser` through Bash. Your run already has a dedicated browser session — reuse it, do not invent separate sessions or profiles.

Core workflow: open a page → snapshot → interact → re-snapshot.

```bash
stella-browser open https://example.com
stella-browser snapshot -i
# Read snapshot output to identify @e refs
stella-browser click @e3
stella-browser wait --load networkidle
stella-browser snapshot -i  # Always re-snapshot after navigation
```

Key commands:
- `stella-browser open <url>` — navigate to URL
- `stella-browser snapshot -i` — get interactive element refs
- `stella-browser click @e1` — click element by ref
- `stella-browser fill @e2 "text"` — clear and type into input
- `stella-browser select @e3 "option"` — select dropdown value
- `stella-browser screenshot` — capture screenshot
- `stella-browser get text @e5` — extract element text
- `stella-browser wait --load networkidle` — wait for network idle

Refs like `@e1` are invalidated after navigation or DOM changes. Always re-snapshot to get fresh refs.

## Desktop app control (Electron)

For Electron app automation, also activate the `electron` skill via `ActivateSkill("electron")` — it covers launching apps with CDP, connecting stella-browser, tab management, and platform-specific commands.

## Deeper reference

For advanced patterns, activate additional skills as needed:
- `ActivateSkill("stella-browser")` — full command reference, sessions, authentication, recording
- `ActivateSkill("browser-patterns")` — Playwright patterns for popups, downloads, iframes, network interception
- `ActivateSkill("browser-api-discovery")` — API reverse-engineering and session token extraction

## Scope

- External websites and desktop applications belong to you.
- Use source edits (Write/Edit) for Stella's own code changes, not stella-browser.
- Handle platform differences (macOS vs Windows) when needed.
