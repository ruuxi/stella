import path from "node:path";
import os from "node:os";

export const resolveStatePath = (env: NodeJS.ProcessEnv = process.env) => {
  if (env.STELLA_DATA_DIR) {
    return path.resolve(env.STELLA_DATA_DIR);
  }
  return path.join(os.homedir(), ".stella");
};
