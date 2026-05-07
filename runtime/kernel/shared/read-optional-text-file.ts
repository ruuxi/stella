import fs from "node:fs/promises";

export const readOptionalTextFile = async (
  filePath: string,
): Promise<string | null> => {
  try {
    const content = (await fs.readFile(filePath, "utf8")).trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
};
