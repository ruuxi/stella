import fs from "node:fs";
import path from "node:path";

export const readHomePrompt = (
  stellaDataDir: string,
  id: string,
): string | undefined => {
  try {
    const content = fs
      .readFileSync(path.join(stellaDataDir, "prompts", `${id}.md`), "utf-8")
      .trim();
    return content || undefined;
  } catch {
    return undefined;
  }
};
