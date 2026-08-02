import path from "node:path";

export const getConnectorStateRoot = (stellaAppDir: string) =>
  path.join(stellaAppDir, "connectors");
