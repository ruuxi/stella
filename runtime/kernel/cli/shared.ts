import path from "node:path";
import os from "node:os";

export const resolveStatePath = () => {
  if (process.env.STELLA_STATE_DIR) {
    return process.env.STELLA_STATE_DIR;
  }
  if (process.env.STELLA_HOME) {
    return path.resolve(process.env.STELLA_HOME);
  }
  return path.join(os.homedir(), ".stella");
};
