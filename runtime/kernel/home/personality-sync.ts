import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
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
const LEGACY_PERSONALITY_TEMPLATE_HASHES = new Set([
  "77444ebcf52265fe96dad0664916d6c4cefdae58de5306ba3920ef6ecc7fa138",
  "8d8d4e691c5152907cfc481e0388c6aec0e19ba5181eaf87e85e96ffd127094d",
]);

let intentionalWriteGeneration = 0;

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const normalizeTemplate = (content: string): string => `${content.trim()}\n`;

export const resolvePersonalityPresetContent = (
  stellaDataDir: string,
  id: PersonalityId,
): string => {
  const content = readHomePrompt(stellaDataDir, `personality-${id}`);
  return content ? normalizeTemplate(content) : "";
};

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
      : "local-existing";
  } catch {
    return "local-existing";
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
  const legacyMatch = LEGACY_PERSONALITY_TEMPLATE_HASHES.has(sha256(current));
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

export const replacePersonalityIfHomeHashMatches = (args: {
  target: string;
  staged: string;
  expectedHomeHash: string | null;
  onAfterTargetCaptured?: () => void;
  onAfterInstalledTargetVerified?: () => void;
}): boolean => {
  const stagedHash = sha256(fs.readFileSync(args.staged, "utf-8"));
  const conflictPath = (): string =>
    `${args.target}.conflict-${process.pid}-${randomUUID()}`;
  const preserveAsConflict = (filePath: string): void => {
    if (fs.existsSync(filePath)) fs.renameSync(filePath, conflictPath());
  };
  const restoreExclusivelyOrPreserve = (filePath: string): boolean => {
    if (!fs.existsSync(filePath)) return false;
    try {
      fs.linkSync(filePath, args.target);
      fs.unlinkSync(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      preserveAsConflict(filePath);
      return false;
    }
  };
  let stagedCleanupError: unknown = null;
  const finishStagedCleanup = <T>(result: T): T => {
    if (stagedCleanupError && fs.existsSync(args.staged)) {
      fs.rmSync(args.staged, { force: true });
    }
    return result;
  };
  const installExclusively = (): boolean => {
    try {
      fs.linkSync(args.staged, args.target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      fs.unlinkSync(args.staged);
    } catch (error) {
      // The target link already exists. Continue through guard verification and
      // conflict recovery; staged cleanup is retried only after finalization.
      stagedCleanupError = error;
    }
    return true;
  };

  if (args.expectedHomeHash === null) {
    args.onAfterTargetCaptured?.();
    return finishStagedCleanup(installExclusively());
  }

  const guard = `${args.target}.cas-${process.pid}-${Date.now()}`;
  try {
    // Atomically capture the exact inode currently at the user-visible path.
    // A path-based editor save after this point creates a new target, causing
    // the exclusive hard-link install below to fail instead of clobbering it.
    fs.renameSync(args.target, guard);
  } catch {
    return false;
  }
  const capturedHash = sha256(fs.readFileSync(guard, "utf-8"));
  if (capturedHash !== args.expectedHomeHash) {
    if (fs.existsSync(args.target)) {
      preserveAsConflict(guard);
    } else {
      restoreExclusivelyOrPreserve(guard);
    }
    return false;
  }

  args.onAfterTargetCaptured?.();
  let installed = false;
  try {
    installed = installExclusively();
  } catch (error) {
    restoreExclusivelyOrPreserve(guard);
    throw error;
  }
  if (!installed) {
    // A direct path-based edit owns the canonical path. Preserve the captured
    // inode too because another process may still be writing through it.
    preserveAsConflict(guard);
    return finishStagedCleanup(false);
  }

  const installedCapture = `${args.target}.installed-${process.pid}-${randomUUID()}`;
  try {
    const targetAfterHash = sha256(fs.readFileSync(args.target, "utf-8"));
    args.onAfterInstalledTargetVerified?.();
    const guardAfterHash = sha256(fs.readFileSync(guard, "utf-8"));
    // Atomically recapture the installed target before deciding which version
    // owns the canonical path. A path edit after this rename creates a new
    // target and wins through the exclusive restore helper below.
    fs.renameSync(args.target, installedCapture);
    const installedHash = sha256(fs.readFileSync(installedCapture, "utf-8"));
    if (fs.existsSync(args.target)) {
      preserveAsConflict(installedCapture);
      preserveAsConflict(guard);
      return finishStagedCleanup(false);
    }

    if (
      guardAfterHash === args.expectedHomeHash &&
      targetAfterHash === stagedHash &&
      installedHash === stagedHash
    ) {
      const restored = restoreExclusivelyOrPreserve(installedCapture);
      // Keep the old inode linked so a late write through an already-open file
      // descriptor remains recoverable. This can leave a redundant artifact,
      // but never silently discards the write.
      preserveAsConflict(guard);
      return finishStagedCleanup(restored);
    }

    if (installedHash !== stagedHash) {
      restoreExclusivelyOrPreserve(installedCapture);
      preserveAsConflict(guard);
    } else {
      restoreExclusivelyOrPreserve(guard);
      preserveAsConflict(installedCapture);
    }
    return finishStagedCleanup(false);
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    try {
      restoreExclusivelyOrPreserve(installedCapture);
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
    try {
      restoreExclusivelyOrPreserve(guard);
    } catch (recoveryError) {
      recoveryErrors.push(recoveryError);
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        "PERSONALITY.md replacement and recovery both failed",
      );
    }
    try {
      finishStagedCleanup(undefined);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "PERSONALITY.md replacement failed after guard recovery",
      );
    }
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
  let expectedHomeHash: string | null | undefined;
  let directEditDetected = false;
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
        const homeHash = sha256(
          await fsp.readFile(path.join(dir, PERSONALITY_FILENAME), "utf-8"),
        );
        expectedHomeHash = homeHash;
        return homeHash;
      } catch {
        expectedHomeHash = null;
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
      if (
        expectedHomeHash === undefined ||
        !replacePersonalityIfHomeHashMatches({
          target,
          staged: temp,
          expectedHomeHash,
        })
      ) {
        directEditDetected = true;
        await fsp.rm(temp, { force: true });
      }
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
      !directEditDetected &&
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
