# Stella Desktop Security Review

**Date:** 2026-03-29
**Scope:** `desktop/` directory — Electron app, browser extension, runtime kernel, AI providers, mobile bridge, storage, discovery

---

## Executive Summary

Stella is a feature-rich Electron desktop application with an AI agent runtime, browser extension, mobile bridge, self-modification capabilities, and extensive system discovery. The codebase demonstrates strong security practices in many areas (contextIsolation, parameterized SQL, PKCE OAuth, safeStorage encryption, SSRF guards). However, several critical and high-severity issues were identified across the attack surface.

**Finding counts by severity:**

| Severity | Count |
|----------|-------|
| CRITICAL | 5 |
| HIGH | 7 |
| MEDIUM | 25 |
| LOW | 22 |

---

## CRITICAL Findings

### C1. Browser Extension Auth Token Empty by Default
- **Files:** `packages/runtime-kernel/tools/stella-browser-bridge-config.ts:4`, `stella-browser/cli/src/native/extension_bridge.rs:494`
- The bridge token defaults to `""`. When empty, the Rust bridge server accepts any connection (`expected_token.is_empty()` → `authenticated = true`). Any local process on `127.0.0.1` can connect to port 39040 and issue commands to control the user's browser.

### C2. Unrestricted Cross-Domain Cookie Access
- **File:** `stella-browser/extension/commands/cookies.js:8,43-68`
- The `cookies_get` command accepts an arbitrary `command.url` and reads cookies for any domain via `chrome.cookies.getAll()`. Combined with `<all_urls>` host permissions, this enables exfiltration of cookies from banking, email, social media, etc. `cookies_set` enables session fixation on arbitrary domains. No allowlist or user confirmation exists.

### C3. Arbitrary JS Injection via Site Mods
- **Files:** `stella-browser/extension/commands/site-mods.js:86-109`, `stella-browser/extension/site-mods.js:42-48`
- `site_mod_set` accepts arbitrary JS/CSS and persists it. The JS is injected into the MAIN world of matching pages via `<script>` tags, granting full access to the page's DOM, cookies, localStorage, and authenticated sessions. No domain restrictions or user confirmation.

### C4. Full Chrome DevTools Protocol Access on Any Tab
- **File:** `stella-browser/extension/lib/debugger.js:14-22`
- The extension attaches `chrome.debugger` (CDP v1.3) to tabs, granting `Runtime.evaluate` (arbitrary JS bypassing CSP), `Network.getResponseBody` (read all traffic including credentials), `Fetch.enable` (intercept/modify requests), `Page.captureScreenshot`, and `Input.dispatch*`. Auto-detach timeout is 5 minutes.

### C5. Network Interception Captures All Credentials
- **Files:** `stella-browser/extension/commands/network.js:20-48,136-167,181-257`
- Network tracking captures full request/response headers (including `Authorization`, `Cookie`, `Set-Cookie`) and response bodies. Route interception via `Fetch.requestPaused` can block, replace, or MITM any request. HAR recording captures complete traffic logs.

---

## HIGH Findings

### H1. No Client-Side Rate Limiting or Cost Controls for AI API Calls
- **Files:** `packages/runtime-kernel/agent-core/agent-loop.ts:163-228`, all AI providers
- The agent loop has no maximum iteration count or token budget. Combined with retry logic (up to 6 calls per request in some providers), a runaway agent could make unlimited API calls. No mechanism exists to limit tokens consumed per session or set a cost budget.

### H2. No Network Sandboxing for Shell Tool
- **File:** `packages/runtime-kernel/tools/shell.ts:305-309`
- The AI agent's Bash tool has zero network restrictions. It can use `curl`, `wget`, `nc`, `ssh`, `python` etc. to exfiltrate any readable file to any external server, completely bypassing the `normalizeSafeExternalUrl` guards that only protect the WebFetch tool.

### H3. Mobile Bridge Exposes LLM API Key CRUD and Auth Tokens
- **Files:** `electron/services/mobile-bridge/bridge-policy.ts:27-29`, `electron/services/mobile-bridge/bootstrap-payload.ts:24`
- The mobile bridge allowlist includes `llmCredentials:list/save/delete`, allowing paired phones to read/write/delete all stored API keys. The bootstrap payload filter includes the `better-auth` localStorage prefix, leaking session/refresh tokens to mobile clients.

### H4. Unencrypted SQLite Database Contains All Conversation Data
- **Files:** `packages/runtime-kernel/storage/database-init.ts:6`, `database-node.ts:8-9`
- The SQLite database (`stella.sqlite`) stores full chat history, runtime thread messages, memories, device identity, social session state, and self-modification records — all unencrypted. WAL sidecar files also contain unencrypted data.

### H5. Plaintext Transcript Mirror Without Restrictive Permissions
- **File:** `packages/runtime-kernel/storage/transcript-mirror.ts:14-28`
- Complete conversation transcripts (chat, runtime threads, runs, memories) are written as unencrypted JSONL files using standard `fs.writeFileSync` without restrictive permissions, inheriting the process's default umask.

### H6. Unsandboxed Extension Loader
- **File:** `packages/runtime-kernel/extensions/loader.ts:24-51`
- Extensions are loaded via dynamic `import()` from the filesystem. Any `.tool.ts`, `.hook.ts`, or `.provider.ts` file in the extensions directory executes with full Node.js privileges. No sandboxing, code signing, integrity verification, or permission system exists.

### H7. Shell History Sensitive Command Filter Gaps
- **File:** `packages/runtime-discovery/shell-history.ts:46-57`
- The sensitive command filter misses: database connection strings (`mysql -u root -pSecret`), SSH URLs with embedded credentials, `export DATABASE_URL=postgres://user:pass@host`, `openssl` operations with key material, and Python/Node one-liners executing scripts that contain secrets. Top 30 commands are sent to the LLM.

---

## MEDIUM Findings

### M1. `voice:executeTool` IPC Handler Lacks Sender Validation
- **File:** `electron/ipc/voice-handlers.ts:191-208`
- Accepts `toolName` and `toolArgs` from any renderer with no `assertPrivilegedSender` check. A compromised renderer could invoke any tool the voice subsystem supports.

### M2. `gameId` Path Traversal
- **File:** `electron/ipc/game-handlers.ts:55-56`
- `path.join(resolveAppsDir(frontendRoot), gameId)` without sanitizing `gameId`. A value like `../../etc` escapes the apps directory. Affects `games:create`, `games:build`, `games:deploy` which run `npm install`/`npm run build` in the resolved directory.

### M3. CSP Includes `unsafe-eval` and Overly Broad Directives
- **File:** `index.html:9`
- Main window CSP: `script-src 'self' 'unsafe-eval'` allows `eval()` and `new Function()`. `connect-src 'self' http: https: ws: wss:` allows network requests to any endpoint. `frame-src 'self' http: https:` allows embedding arbitrary external content.

### M4. Multiple IPC Handlers Missing `assertPrivilegedSender`
- **Files:** `voice-handlers.ts` (multiple), `capture-handlers.ts` (multiple), `agent-handlers.ts:142-190`, `browser-handlers.ts:189-290`
- Voice state, capture, agent status, and browser data handlers are accessible to any renderer frame without sender validation.

### M5. `beforeToolCall` Hook Silently Swallows Errors
- **File:** `packages/runtime-kernel/agent-core/agent.ts:561-567`
- If the `beforeToolCall` hook throws, the exception is caught and `undefined` is returned, allowing tool execution to proceed. If this hook is used as a security gate, errors bypass it silently.

### M6. System Prompt Replaceable by Extensions via Hooks
- **File:** `packages/runtime-kernel/agent-runtime/run-preparation.ts:47-58`
- The `before_agent_start` hook can set `systemPromptReplace` to completely replace the system prompt, removing safety instructions. `systemPromptAppend` can inject overriding instructions.

### M7. Model Routing Implicit Provider Fallback
- **Files:** `packages/runtime-kernel/model-routing.ts:162-225`, `model-routing-matching.ts:10-31`
- User-provided model names are parsed and routed through a cascading fallback chain (direct → OpenRouter → Vercel Gateway → Stella). Specifying a model for a provider without configured keys silently falls back to routing through other providers.

### M8. Anthropic OAuth Reuses PKCE Verifier as `state`
- **File:** `packages/ai/utils/oauth/anthropic.ts:250,265-266`
- The PKCE `verifier` is used as the OAuth `state` parameter, exposing it in browser history, server logs, and redirect URLs. Anyone observing the callback URL can obtain the verifier and potentially complete the token exchange.

### M9. CLI `auth.json` Stores Tokens in Plaintext
- **File:** `packages/ai/cli.ts:24-25`
- `saveAuth()` writes OAuth credentials (including refresh/access tokens) to `auth.json` in the CWD using plain `writeFileSync` with no encryption and no restrictive file permissions.

### M10. OpenAI Codex Logs Full Token Response JSON
- **Files:** `packages/ai/utils/oauth/openai-codex.ts:121,132,169`
- On error, `console.error` logs the full response body including `access_token` and `refresh_token` fields.

### M11. Bedrock Auth Bypass via Environment Variable
- **File:** `packages/ai/providers/amazon-bedrock.ts:105-109`
- When `AWS_BEDROCK_SKIP_AUTH=1`, dummy credentials are used. Any process that can set env vars bypasses Bedrock authentication.

### M12. Global HTTP Proxy Intercepts All Provider Traffic
- **File:** `packages/ai/utils/http-proxy.ts:8-13`
- `EnvHttpProxyAgent` is set as the global `fetch()` dispatcher. A malicious HTTP_PROXY could intercept all API keys sent in Authorization headers. No TLS certificate pinning exists.

### M13. Tool Allowlist Defaults to All Tools
- **File:** `packages/runtime-kernel/agent-runtime/tool-adapters.ts:77-79`
- When no allowlist is configured, all `STELLA_LOCAL_TOOLS` are available including device tools, task management, web fetch, skill activation, and memory operations.

### M14. Extension Models Can Register Without Credential Requirement
- **File:** `packages/runtime-kernel/model-routing-direct.ts:48-57`
- Extensions can register models with `allowBaseUrlWithoutCredential: true`, pointing to attacker-controlled endpoints.

### M15. `sanitizeHtmlFragment` Bypassed in Node.js Context
- **File:** `src/shared/lib/safe-html.ts:39-41`
- Returns raw unsanitized HTML when `document` is undefined (any non-browser context).

### M16. `file:` Protocol Allowed in Attachment Image URLs
- **File:** `src/shared/lib/url-safety.ts:33-39`
- `ATTACHMENT_IMAGE_PROTOCOLS` includes `file:`, `blob:`, and `data:`, allowing probing of local filesystem paths via image load success/failure.

### M17. Narrow Dangerous Command Blocklist
- **File:** `packages/runtime-kernel/tools/schemas.ts:47-72`
- `rm -rf` patterns require specific flag groupings; `rm --recursive --force /` is not caught. `chmod 000 /`, `find / -delete`, `truncate` are not blocked.

### M18. Delete Bypass Rewriting Is Circumventable
- **File:** `packages/runtime-kernel/tools/shell.ts:62-66`
- Regex-based rewriting misses `env rm`, `exec rm`, `$(which rm)`, symlinks, and interpreter-based deletion (`perl -e`, `node -e`, `python script.py`).

### M19. Sensitive Dotfiles Not Path-Blocked
- **File:** `packages/runtime-kernel/tools/command-safety.ts:37-72`
- `isBlockedPath` blocks `/etc`, `/usr`, `/bin`, etc. but NOT `~/.ssh/`, `~/.gnupg/`, `~/.config/`, shell RC files. The AI agent can read/write SSH keys, GPG keys, and dotfiles.

### M20. Extension Tools Can Override Built-in Handlers
- **File:** `packages/runtime-kernel/tools/registry.ts:135-145`
- No name collision check prevents an extension from replacing built-in tools like "Read" or "Bash" with unguarded versions.

### M21. Windows ACL Only Adds Permissions
- **File:** `packages/runtime-kernel/home/private-fs.ts:36-49`
- `icacls /grant username:F` adds Full Control but does not strip inherited permissions from other users via `/inheritance:r`.

### M22. State Directory and Database Lack Private Permissions
- **File:** `packages/runtime-kernel/storage/database-init.ts:8-10`
- `state/` directory and SQLite database created with default umask, unlike identity map and device key files which use `writePrivateFile`.

### M23. Temporary Discovery Database Copies Lack Restrictive Permissions
- **Files:** `firefox-data.ts:175-176`, `safari-data.ts:66-69`, `messages-notes.ts:41,48`, `system-signals.ts:109-110`
- Sensitive OS databases (iMessage, Safari history, Firefox, knowledgeC) copied to `cache/` directories created without restrictive permissions. iMessage DB left in cache if process crashes.

### M24. Debug Logging Leaks Real Contact Names
- **File:** `packages/runtime-kernel/home/identity-map.ts:392-393`
- `addContacts` logs real names and identifiers alongside aliases to stderr, defeating pseudonymization.

### M25. Pseudonymization Has Limited Pattern Coverage
- **Files:** `packages/runtime-kernel/home/identity-map.ts:406-462`, `runtime-discovery/collect-all.ts:375-383`
- Regex-based replacement misses partial names, nicknames, names in URLs, and different Unicode normalizations. Calendar event title parsing only matches "with {Name}" pattern.

---

## Positive Security Observations

The following areas demonstrate strong security practices:

1. **Electron fundamentals:** `contextIsolation: true`, `nodeIntegration: false` everywhere. Preload exposes only a narrow, channel-specific API. `window.open` denied, `will-navigate` intercepted.
2. **SQL injection prevention:** All queries use parameterized prepared statements. `escapeSqlLike` properly escapes LIKE wildcards.
3. **PKCE OAuth:** Correctly implemented with 256-bit verifiers and SHA-256 challenges across Anthropic, OpenAI, Google providers.
4. **SSRF protection:** `normalizeSafeExternalUrl` blocks localhost, private IPs, performs DNS resolution checks, blocks embedded credentials, auto-upgrades HTTP→HTTPS.
5. **Credential encryption:** LLM API keys encrypted via `safeStorage` (OS keychain). Device private keys encrypted at rest. Identity map encrypted before disk write.
6. **External link handling:** Rate-limited (max 20/15s, 300ms minimum interval), protocol-validated (HTTP/HTTPS only), sender-checked.
7. **Social session path traversal protection:** `ensurePathWithinRoot` validates resolved paths don't escape workspace root.
8. **Deferred delete safety:** Root path protection, trash directory validation, shell function wrappers for `rm`/`rmdir`/`unlink`.
9. **Mobile bridge:** Cloudflare tunnel hostname is server-assigned (not predictable), auth is server-mediated, CORS origin checking present, sessions invalidated on sign-out, loopback-only binding.

---

## Recommendations Summary

### Immediate (Critical/High)
1. **Enforce non-empty browser bridge auth token** — reject connections when the token is empty.
2. **Add domain allowlists** to cookie, evaluate, and site-mod extension commands.
3. **Add network sandboxing** for the shell tool (e.g., network namespace, firewall rules, or iptables-based restrictions).
4. **Remove `llmCredentials:*` from mobile bridge allowlist** and tighten bootstrap payload prefix filter to exclude auth tokens.
5. **Encrypt the SQLite database** (e.g., SQLCipher) and apply restrictive permissions to the `state/` directory.
6. **Apply `0o600` permissions** to transcript mirror files and discovery cache directories.
7. **Add sandboxing, code signing, or integrity verification** for extensions.
8. **Expand shell history sensitive command filters** to catch database connection strings, SSH URLs with passwords, env var exports with secrets.

### Short-term (Medium)
9. Add `assertPrivilegedSender` to all voice, capture, and agent IPC handlers.
10. Sanitize `gameId` against path traversal in game handlers.
11. Remove `unsafe-eval` from CSP; tighten `connect-src` to specific domains.
12. Fix `beforeToolCall` hook to propagate errors instead of swallowing them.
13. Generate a separate random `state` parameter in Anthropic OAuth (don't reuse PKCE verifier).
14. Restrict `auth.json` file permissions to `0o600`.
15. Redact tokens from error log messages in OAuth flows.
16. Block `~/.ssh/`, `~/.gnupg/`, `~/.config/`, and shell RC files in `isBlockedPath`.
17. Add name collision checks preventing extensions from overriding built-in tool handlers.

### Long-term
18. Implement client-side token budgets and cost caps for the agent loop.
19. Add a mandatory permission/confirmation system for high-risk extension commands.
20. Move CSP from meta tags to HTTP response headers with violation reporting.
21. Implement TLS certificate pinning for AI provider endpoints.
22. Bind mobile bridge sessions to client metadata (device ID, IP) to prevent session hijacking.
