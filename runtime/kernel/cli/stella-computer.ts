#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { executeStellaComputerCommand } from "../computer-use/stella-computer-executor.js";

export type StellaComputerCliIo = {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
};

export const runStellaComputerCli = async (
  argv: string[],
  io: StellaComputerCliIo = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
) => {
  const result = await executeStellaComputerCommand(argv, {
    cwd: process.cwd(),
    cliPath: process.argv[1],
    env: process.env,
  });
  if (result.stdout) io.stdout(result.stdout);
  if (result.stderr) io.stderr(result.stderr);
  return result.exitCode;
};

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (invokedPath === import.meta.url) {
  const keepAlive = setInterval(() => undefined, 1_000);
  void runStellaComputerCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    })
    .finally(() => {
      clearInterval(keepAlive);
    });
}
