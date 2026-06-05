/**
 * `~/.stella/PERSONALITY.md` — Stella's selected voice/register, injected as a
 * hidden startup doc on the first orchestrator turn (the same path core memory
 * takes) rather than into the system prompt every turn.
 *
 * Lifecycle:
 * - Seeded on first read from the selected preset (or the Stella default when
 *   no preference is set).
 * - Overwritten when the user picks a preset in onboarding or settings.
 * - Read into the agent context at turn start; injected as a startup doc on the
 *   conversation's first turn, then replayed from persisted history. A new
 *   preset (or hand edit) therefore takes effect on the next fresh
 *   conversation, not mid-thread.
 *
 * The file is plain markdown so power users can edit it freely. On each read we
 * use whatever is on disk verbatim — never re-compose from a preset if the file
 * already exists.
 */

import fs from "node:fs";
import path from "node:path";
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from "../shared/private-fs.js";
import {
  PERSONALITY_TEMPLATES,
  coercePersonalityId,
  type PersonalityId,
} from "../../contracts/personality.js";
import { getPersonalityVoiceId } from "../preferences/local-preferences.js";

const PERSONALITY_FILE_RELATIVE = "PERSONALITY.md";

const personalityFilePath = (stellaHome: string): string =>
  path.join(stellaHome, PERSONALITY_FILE_RELATIVE);

const composePersonalityContent = (id: PersonalityId): string =>
  PERSONALITY_TEMPLATES[id].trim() + "\n";

/**
 * Read the persisted personality file, seeding it on first access from the
 * user's preset preference (or the Stella default) so the orchestrator always
 * has a personality to inject.
 */
export const readOrSeedPersonality = (stellaHome: string): string => {
  const filePath = personalityFilePath(stellaHome);
  try {
    const existing = fs.readFileSync(filePath, "utf-8").trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch {
    // Fall through to seed.
  }

  const seeded = composePersonalityContent(
    coercePersonalityId(getPersonalityVoiceId(stellaHome)),
  );
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      ensurePrivateDirSync(dir);
    }
    writePrivateFileSync(filePath, seeded);
  } catch {
    // Seeding is best-effort; the live string is still returned below.
  }
  return seeded.trim();
};

/**
 * Overwrite `~/.stella/PERSONALITY.md` with the given preset. Used when the
 * user picks a personality in onboarding or settings.
 */
export const writePersonality = (
  stellaHome: string,
  id: PersonalityId,
): string => {
  const content = composePersonalityContent(id);
  const filePath = personalityFilePath(stellaHome);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    ensurePrivateDirSync(dir);
  }
  writePrivateFileSync(filePath, content);
  return content.trim();
};

export const getPersonalityFilePath = (stellaHome: string): string =>
  personalityFilePath(stellaHome);
