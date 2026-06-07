import path from "node:path";
import os from "node:os";

export const resolveStatePath = () => {
  if (process.env.STELLA_DATA_DIR) {
    return path.resolve(process.env.STELLA_DATA_DIR);
  }
  return path.join(os.homedir(), ".stella");
};
