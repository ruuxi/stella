#!/usr/bin/env node
/**
 * stella-ui CLI — invoked by agents via Bash.
 *
 * Usage:
 *   stella-ui snapshot              # Get compact UI snapshot
 *   stella-ui click @e5             # Click element by ref
 *   stella-ui fill @e3 "some text"  # Fill input field
 *   stella-ui select @e3 "option"   # Select dropdown value
 */

import http from "node:http";
import path from "node:path";

const socketPath =
  process.platform === "win32"
    ? "\\\\.\\pipe\\stella-ui"
    : path.resolve(process.cwd(), ".stella", "state", "stella-ui.sock");

const [command, ...args] = process.argv.slice(2);

if (!command) {
  process.stdout.write(
    `stella-ui — control Stella's UI from the command line

Usage:
  stella-ui snapshot                          Show current UI state
  stella-ui click <ref>                       Click an element (e.g. @e5)
  stella-ui fill <ref> <text>                 Fill an input field
  stella-ui select <ref> <value>              Select a dropdown value
  stella-ui generate <panel> <prompt>         Populate a panel with content

Element refs (like @e5) are assigned by the snapshot command.
Run snapshot first to discover available elements.
The generate command uses a fast model to update a panel's content.
`
  );
  process.exit(0);
}

const payload = JSON.stringify({ command, args });

const req = http.request(
  {
    socketPath,
    path: "/",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  },
  (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      process.stdout.write(body);
      if (!body.endsWith("\n")) process.stdout.write("\n");
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  },
);

req.on("error", (err) => {
  process.stderr.write(`Error: stella-ui server not reachable at ${socketPath}: ${err.message}\n`);
  process.exit(1);
});

req.write(payload);
req.end();
