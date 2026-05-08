#!/usr/bin/env bun
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binDir = join(repoRoot, "node_modules", ".bin");
const shimPath = join(binDir, "tsc");
const cmdShimPath = join(binDir, "tsc.cmd");
const ps1ShimPath = join(binDir, "tsc.ps1");

const shim = `#!/usr/bin/env sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")

case \`uname\` in
  *CYGWIN*|*MINGW*|*MSYS*) basedir=\`cygpath -w "$basedir"\`;;
esac

exec "$basedir/tsgo" "$@"
`;

await mkdir(binDir, { recursive: true });
await rm(shimPath, { force: true });
await writeFile(shimPath, shim, "utf8");
await chmod(shimPath, 0o755);

await writeFile(cmdShimPath, `@ECHO off\r\n"%~dp0\\tsgo.cmd" %*\r\n`, "utf8");
await writeFile(
  ps1ShimPath,
  `#!/usr/bin/env pwsh\r\n& "$PSScriptRoot/tsgo.ps1" $args\r\nexit $LASTEXITCODE\r\n`,
  "utf8",
);
