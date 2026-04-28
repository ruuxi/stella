import fs from "fs";
import path from "path";
import { resolveStellaStatePath } from "../home/stella-home.js";

const SQLITE_BASENAMES = [
  "stella.sqlite",
  "stella.sqlite-shm",
  "stella.sqlite-wal",
] as const;

export const resetMessageStorage = async (stellaHome: string): Promise<void> => {
  const stateRoot = resolveStellaStatePath(stellaHome);

  await Promise.allSettled([
    ...SQLITE_BASENAMES.map((basename) =>
      fs.promises.rm(path.join(stateRoot, basename), { force: true }),
    ),
    fs.promises.rm(path.join(stateRoot, "transcripts"), {
      recursive: true,
      force: true,
    }),
  ]);
};
