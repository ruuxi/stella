import fs from "node:fs";
import path from "node:path";

import { readConfiguredConvexSiteUrl } from "../../runtime/kernel/convex-urls.js";

const ENV_KEYS = [
  "STELLA_CONVEX_SITE_URL",
  "CONVEX_SITE_URL",
  "VITE_CONVEX_SITE_URL",
] as const;

const readEnvValue = (raw: string, key: string): string | null => {
  const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m"));
  if (!match) return null;
  const value = match[1]!.replace(/^(['"])(.*)\1$/, "$2");
  return readConfiguredConvexSiteUrl(value);
};

export const resolvePackagedPromptSiteUrl = (
  stellaAppDir: string,
): string | null => {
  for (const key of ENV_KEYS) {
    const configured = readConfiguredConvexSiteUrl(process.env[key]);
    if (configured) return configured;
  }

  for (const relativePath of [
    path.join("desktop", ".env.local"),
    path.join("desktop", ".env"),
    ".env.local",
    ".env",
  ]) {
    try {
      const raw = fs.readFileSync(
        path.join(stellaAppDir, relativePath),
        "utf-8",
      );
      for (const key of ENV_KEYS) {
        const configured = readEnvValue(raw, key);
        if (configured) return configured;
      }
    } catch {
      // Try the next packaged configuration location.
    }
  }
  return null;
};
