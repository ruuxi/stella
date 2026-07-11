import { createHash } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  PERSONALITY_TEMPLATES,
  coercePersonalityId,
  type PersonalityId,
} from "../../contracts/personality.js";
import { getPersonalityVoiceId } from "../preferences/local-preferences.js";
import { readHomePrompt } from "../prompts/home-prompts.js";
import {
  ensurePrivateDir,
  ensurePrivateDirSync,
} from "../shared/private-fs.js";
import {
  reconcileBundledEntries,
  type BundledEntryAdapter,
  type BundledManifestEntry,
  type BundledSyncReport,
} from "./bundled-sync.js";

export const PERSONALITY_MANIFEST_FILENAME = ".personality-manifest.json";
const PERSONALITY_ENTRY_ID = "PERSONALITY";
const PERSONALITY_FILENAME = "PERSONALITY.md";
const LEGACY_PERSONALITY_REVISION = "bundled:legacy-personality";
const MAX_RECONCILE_RETRIES = 3;

let intentionalWriteGeneration = 0;

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const normalizeTemplate = (content: string): string => `${content.trim()}\n`;

export const resolvePersonalityPresetContent = (
  stellaDataDir: string,
  id: PersonalityId,
): string =>
  normalizeTemplate(
    readHomePrompt(
      stellaDataDir,
      `personality-${id}`,
      PERSONALITY_TEMPLATES[id],
    ),
  );

const readPresetSourceRevision = (
  stellaDataDir: string,
  id: PersonalityId,
): string => {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(
        path.join(stellaDataDir, "prompts", ".bundled-manifest.json"),
        "utf-8",
      ),
    ) as {
      entries?: Record<string, Partial<BundledManifestEntry>>;
    };
    const revision = parsed.entries?.[`personality-${id}`]?.sourceRevision;
    return typeof revision === "string" && revision.trim()
      ? revision
      : "bundled-bootstrap";
  } catch {
    return "bundled-bootstrap";
  }
};

const metadataContent = (
  stellaDataDir: string,
  id: PersonalityId,
  content: string,
): string =>
  `${JSON.stringify(
    {
      version: 2,
      entries: {
        [PERSONALITY_ENTRY_ID]: {
          lastSyncedHash: sha256(content),
          sourceRevision: readPresetSourceRevision(stellaDataDir, id),
          customized: false,
        },
      },
    },
    null,
    2,
  )}\n`;

const readFileIfPresentSync = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
};

const atomicReplaceSync = (filePath: string, content: string): void => {
  ensurePrivateDirSync(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}-${intentionalWriteGeneration}`;
  try {
    fs.writeFileSync(temp, content, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temp, filePath);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
};

const restoreFileSync = (filePath: string, content: string | null): void => {
  if (content === null) {
    fs.rmSync(filePath, { force: true });
  } else {
    atomicReplaceSync(filePath, content);
  }
};

export const writePersonalitySyncMetadata = (
  stellaDataDir: string,
  id: PersonalityId,
  content: string,
): void => {
  atomicReplaceSync(
    path.join(stellaDataDir, PERSONALITY_MANIFEST_FILENAME),
    metadataContent(stellaDataDir, id, content),
  );
};

export const writePersonalityTransaction = (
  stellaDataDir: string,
  id: PersonalityId,
  content: string,
): void => {
  intentionalWriteGeneration += 1;
  const personalityPath = path.join(stellaDataDir, PERSONALITY_FILENAME);
  const manifestPath = path.join(stellaDataDir, PERSONALITY_MANIFEST_FILENAME);
  const previousPersonality = readFileIfPresentSync(personalityPath);
  const previousManifest = readFileIfPresentSync(manifestPath);
  try {
    atomicReplaceSync(personalityPath, content);
    atomicReplaceSync(
      manifestPath,
      metadataContent(stellaDataDir, id, content),
    );
  } catch (error) {
    try {
      restoreFileSync(personalityPath, previousPersonality);
      restoreFileSync(manifestPath, previousManifest);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Could not write or roll back personality preset",
      );
    }
    throw error;
  }
};

const seedLegacyPersonalityMetadata = async (
  stellaDataDir: string,
): Promise<void> => {
  const manifestPath = path.join(stellaDataDir, PERSONALITY_MANIFEST_FILENAME);
  try {
    const parsed = JSON.parse(await fsp.readFile(manifestPath, "utf-8")) as {
      entries?: Record<string, unknown>;
    };
    if (parsed.entries?.[PERSONALITY_ENTRY_ID]) return;
  } catch {
    // An absent/corrupt pre-tracking manifest is rebuilt only for known seeds.
  }

  let current: string;
  try {
    current = await fsp.readFile(
      path.join(stellaDataDir, PERSONALITY_FILENAME),
      "utf-8",
    );
  } catch {
    return;
  }
  const legacyMatch = Object.values(PERSONALITY_TEMPLATES).some(
    (template) => normalizeTemplate(template) === current,
  );
  if (!legacyMatch) return;

  await ensurePrivateDir(stellaDataDir);
  const serialized = `${JSON.stringify(
    {
      version: 2,
      entries: {
        [PERSONALITY_ENTRY_ID]: {
          lastSyncedHash: sha256(current),
          sourceRevision: LEGACY_PERSONALITY_REVISION,
          customized: false,
        },
      },
    },
    null,
    2,
  )}\n`;
  const temp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsp.writeFile(temp, serialized, { encoding: "utf-8", mode: 0o600 });
    await fsp.rename(temp, manifestPath);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
};

const reconcileSelectedPersonalityAttempt = async (
  stellaDataDir: string,
  sourceRevision: string,
): Promise<{ report: BundledSyncReport; stable: boolean }> => {
  await seedLegacyPersonalityMetadata(stellaDataDir);
  const selectedId = coercePersonalityId(getPersonalityVoiceId(stellaDataDir));
  const generation = intentionalWriteGeneration;
  const content = resolvePersonalityPresetContent(stellaDataDir, selectedId);
  const sourceKey = `personality:${selectedId}:${sourceRevision}`;
  const adapter: BundledEntryAdapter = {
    listIds: async (dir) => {
      if (dir === sourceKey) return [PERSONALITY_ENTRY_ID];
      try {
        return (await fsp.stat(path.join(dir, PERSONALITY_FILENAME))).isFile()
          ? [PERSONALITY_ENTRY_ID]
          : [];
      } catch {
        return [];
      }
    },
    hash: async (dir) => {
      if (dir === sourceKey) return sha256(content);
      try {
        return sha256(
          await fsp.readFile(path.join(dir, PERSONALITY_FILENAME), "utf-8"),
        );
      } catch {
        return null;
      }
    },
    copy: async (_src, dest) => {
      await ensurePrivateDir(dest);
      const target = path.join(dest, PERSONALITY_FILENAME);
      const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(temp, content, { encoding: "utf-8", mode: 0o600 });
      if (
        generation !== intentionalWriteGeneration ||
        coercePersonalityId(getPersonalityVoiceId(stellaDataDir)) !== selectedId
      ) {
        await fsp.rm(temp, { force: true });
        return;
      }
      // The final check and rename are synchronous so an intentional write in
      // this process cannot interleave between them.
      fs.renameSync(temp, target);
    },
    remove: async (dir) => {
      await fsp.rm(path.join(dir, PERSONALITY_FILENAME), { force: true });
    },
  };
  const report = await reconcileBundledEntries(
    sourceKey,
    stellaDataDir,
    adapter,
    {
      manifestFilename: PERSONALITY_MANIFEST_FILENAME,
      sourceRevision,
      removeObsolete: false,
    },
  );
  return {
    report,
    stable:
      generation === intentionalWriteGeneration &&
      coercePersonalityId(getPersonalityVoiceId(stellaDataDir)) === selectedId,
  };
};

export const reconcileSelectedPersonality = async (
  stellaDataDir: string,
  sourceRevision: string,
): Promise<BundledSyncReport> => {
  let latest: BundledSyncReport = { actions: [] };
  for (let attempt = 0; attempt < MAX_RECONCILE_RETRIES; attempt += 1) {
    const result = await reconcileSelectedPersonalityAttempt(
      stellaDataDir,
      sourceRevision,
    );
    latest = result.report;
    if (result.stable) return result.report;
  }
  return latest;
};
