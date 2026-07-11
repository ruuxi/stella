import fs from "node:fs";
import path from "node:path";

export const readHomePrompt = (
  stellaDataDir: string,
  id: string,
  fallback: string,
): string => {
  try {
    const content = fs
      .readFileSync(path.join(stellaDataDir, "prompts", `${id}.md`), "utf-8")
      .trim();
    return content || fallback;
  } catch {
    return fallback;
  }
};
