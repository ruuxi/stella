/**
 * `state/personality.md` — the dynamic prefix to the orchestrator system
 * prompt. Owns Stella's identity intro and her selected voice.
 *
 * Lifecycle:
 * - Seeded on first run from the bundled template + the user's voice
 *   preference (or the default voice if no preference).
 * - Overwritten when the user picks a different voice in onboarding/settings.
 * - Read live on every orchestrator turn and prepended to the system prompt.
 *
 * The file is plain markdown so power users can edit it freely. On each
 * read we use whatever is on disk verbatim — never re-compose from the
 * template if the file already exists.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensurePrivateDirSync,
  writePrivateFileSync,
} from "../shared/private-fs.js";
import {
  DEFAULT_PERSONALITY_VOICE_ID,
  findPersonalityVoice,
} from "../../extensions/stella-runtime/personality/voices.js";

const PERSONALITY_FILE_RELATIVE = path.join("state", "personality.md");
const VOICE_TOKEN = "{{voice}}";

const BUNDLED_TEMPLATE_URL = new URL(
  "../../extensions/stella-runtime/personality/template.md",
  import.meta.url,
);

const personalityFilePath = (stellaHome: string): string =>
  path.join(stellaHome, PERSONALITY_FILE_RELATIVE);

const readBundledTemplate = (): string => {
  const filePath = fileURLToPath(BUNDLED_TEMPLATE_URL);
  return fs.readFileSync(filePath, "utf-8");
};

const composePersonalityContent = (voiceId: string | undefined): string => {
  const template = readBundledTemplate();
  const voice = findPersonalityVoice(voiceId);
  return template.replace(VOICE_TOKEN, voice.promptBlock.trim()).trim() + "\n";
};

/**
 * Read the persisted personality file. Seeds it on first access using the
 * supplied voice id (or the default voice) so the orchestrator always has
 * a personality prefix to prepend.
 */
export const readOrSeedPersonality = (
  stellaHome: string,
  voiceId: string | undefined,
): string => {
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
    voiceId ?? DEFAULT_PERSONALITY_VOICE_ID,
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
 * Overwrite `state/personality.md` with the template interpolated against
 * the given voice id. Used when the user picks a voice in onboarding or
 * changes it in settings.
 */
export const writePersonalityForVoice = (
  stellaHome: string,
  voiceId: string,
): string => {
  const content = composePersonalityContent(voiceId);
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
