import { createHash } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  PERSONALITY_TEMPLATES,
  coercePersonalityId,
  type PersonalityId,
} from "../../contracts/personality.js";
import { readHomePrompt } from "../prompts/home-prompts.js";
import { getPersonalityVoiceId } from "../preferences/local-preferences.js";
import {
  ensurePrivateDir,
  writePrivateFileSync,
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

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

export const resolvePersonalityPresetContent = (
  stellaDataDir: string,
  id: PersonalityId,
): string =>
  `${readHomePrompt(
    stellaDataDir,
    `personality-${id}`,
    PERSONALITY_TEMPLATES[id],
  ).trim()}\n`;

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

export const writePersonalitySyncMetadata = (
  stellaDataDir: string,
  id: PersonalityId,
  content: string,
): void => {
  writePrivateFileSync(
    path.join(stellaDataDir, PERSONALITY_MANIFEST_FILENAME),
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
    )}\n`,
  );
};

export const reconcileSelectedPersonality = async (
  stellaDataDir: string,
  sourceRevision: string,
): Promise<BundledSyncReport> => {
  const selectedId = coercePersonalityId(getPersonalityVoiceId(stellaDataDir));
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
      const temp = `${target}.tmp-${process.pid}`;
      await fsp.writeFile(temp, content, { encoding: "utf-8", mode: 0o600 });
      await fsp.rename(temp, target);
    },
    remove: async (dir) => {
      await fsp.rm(path.join(dir, PERSONALITY_FILENAME), { force: true });
    },
  };
  return reconcileBundledEntries(sourceKey, stellaDataDir, adapter, {
    manifestFilename: PERSONALITY_MANIFEST_FILENAME,
    sourceRevision,
    removeObsolete: false,
  });
};
