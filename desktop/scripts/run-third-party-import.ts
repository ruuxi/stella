import os from "node:os";
import path from "node:path";

import {
  detectThirdPartyMigrationSources,
  previewThirdPartyMigration,
  runThirdPartyMigration,
  type ThirdPartyMigrationSelection,
  type ThirdPartyMigrationSource,
} from "../../runtime/kernel/migration/third-party-importers.js";

type RequestPayload = {
  action?: "detect" | "preview" | "run";
  source?: ThirdPartyMigrationSource;
  sourceRoot?: string;
  stellaHome?: string;
  selection?: ThirdPartyMigrationSelection;
};

const payload = JSON.parse(process.argv[2] ?? "{}") as RequestPayload;

const stellaHome =
  payload.stellaHome ??
  process.env.STELLA_HOME ??
  path.join(os.homedir(), ".stella");

const main = async () => {
  if (payload.action === "detect") {
    return await detectThirdPartyMigrationSources();
  }
  if (payload.action === "preview") {
    if (!payload.source) throw new Error("Missing import source.");
    return await previewThirdPartyMigration({
      source: payload.source,
      sourceRoot: payload.sourceRoot,
    });
  }
  if (payload.action === "run") {
    if (!payload.source) throw new Error("Missing import source.");
    return await runThirdPartyMigration({
      source: payload.source,
      sourceRoot: payload.sourceRoot,
      stellaHome,
      selection: payload.selection,
    });
  }
  throw new Error("Unsupported import action.");
};

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
