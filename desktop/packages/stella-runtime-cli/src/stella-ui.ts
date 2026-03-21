#!/usr/bin/env node
import { runRuntimeCommand } from "./shared.js";

const argv = process.argv.slice(2);

if (argv.length === 0) {
  process.stdout.write(
    `stella-ui - control Stella's UI from the command line

Usage:
  stella-ui snapshot
  stella-ui click <ref>
  stella-ui fill <ref> <text>
  stella-ui select <ref> <value>
  stella-ui generate <panel> <prompt>
`,
  );
  process.exit(0);
}

try {
  const result = await runRuntimeCommand({
    commandId: "stella-ui",
    argv,
  });
  process.stdout.write(result.body);
  if (!result.body.endsWith("\n")) {
    process.stdout.write("\n");
  }
  process.exit(result.statusCode === 200 ? 0 : 1);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
