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

const port = process.env.STELLA_UI_PORT;
if (!port) {
  process.stderr.write("Error: STELLA_UI_PORT not set\n");
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);

if (!command) {
  process.stdout.write(
    `stella-ui — control Stella's UI from the command line

Usage:
  stella-ui snapshot              Show current UI state
  stella-ui click <ref>           Click an element (e.g. @e5)
  stella-ui fill <ref> <text>     Fill an input field
  stella-ui select <ref> <value>  Select a dropdown value

Element refs (like @e5) are assigned by the snapshot command.
Run snapshot first to discover available elements.
`
  );
  process.exit(0);
}

const payload = JSON.stringify({ command, args });

const req = http.request(
  {
    hostname: "127.0.0.1",
    port: Number(port),
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
  process.stderr.write(`Error: could not connect to stella-ui server: ${err.message}\n`);
  process.exit(1);
});

req.write(payload);
req.end();
