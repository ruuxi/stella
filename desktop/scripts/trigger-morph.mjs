#!/usr/bin/env node
/**
 * Trigger the capture/morph animation in a running dev Electron instance.
 *
 *   bun run morph:test                # default 1500ms hold, no reload
 *   bun run morph:test -- --hold 600
 *   bun run morph:test -- --reload    # forces a full webContents reload behind the cover
 *   bun run morph:test -- --port 57316
 *
 * Requires `bun run electron:dev` to be running (the trigger HTTP listener is
 * dev-only).
 */

const DEFAULT_PORT = 57316;

function parseArgs(argv) {
  const out = { holdMs: 1500, reload: false, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--hold" || arg === "--hold-ms") {
      const next = argv[++i];
      const parsed = Number(next);
      if (Number.isFinite(parsed)) out.holdMs = Math.max(0, Math.round(parsed));
      continue;
    }
    if (arg === "--reload" || arg === "--full-reload") {
      out.reload = true;
      continue;
    }
    if (arg === "--port") {
      const next = argv[++i];
      const parsed = Number(next);
      if (Number.isFinite(parsed)) out.port = Math.round(parsed);
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: bun run morph:test [-- --hold <ms>] [--reload] [--port <n>]",
      );
      process.exit(0);
    }
  }
  return out;
}

const { holdMs, reload, port } = parseArgs(process.argv.slice(2));

const url = new URL(`http://127.0.0.1:${port}/trigger-morph`);
url.searchParams.set("holdMs", String(holdMs));
if (reload) url.searchParams.set("reload", "1");

try {
  const res = await fetch(url, { method: "POST" });
  const body = await res.text();
  if (!res.ok) {
    console.error(`[morph:test] HTTP ${res.status}: ${body}`);
    process.exit(1);
  }
  console.log(`[morph:test] ${body}`);
} catch (error) {
  console.error(
    `[morph:test] could not reach dev Electron on 127.0.0.1:${port}`,
    "\n  Is `bun run electron:dev` running?",
    `\n  ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
