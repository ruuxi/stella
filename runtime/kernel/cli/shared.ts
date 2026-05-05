import path from "node:path";

export const resolveStatePath = () => {
  if (process.env.STELLA_STATE_DIR) {
    return process.env.STELLA_STATE_DIR;
  }
  if (process.env.STELLA_HOME) {
    return path.resolve(process.env.STELLA_HOME, "state");
  }
  if (process.env.STELLA_ROOT) {
    return path.resolve(process.env.STELLA_ROOT, "state");
  }
  return path.resolve(process.cwd(), "state");
};
