import path from "path";
import { fileURLToPath } from "url";
import {
  AUTH_PROTOCOL,
  HARD_RESET_MUTABLE_HOME_PATHS,
  STARTUP_STAGE_DELAY_MS,
  STELLA_SESSION_PARTITION,
} from "./bootstrap/constants.js";
import { createBootstrapContext } from "./bootstrap/context.js";
import {
  initializeBootstrapSingleInstance,
  registerBootstrapLifecycle,
} from "./bootstrap/lifecycle.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.NODE_ENV === "development";

export const bootstrapMainProcess = () => {
  const context = createBootstrapContext({
    authProtocol: AUTH_PROTOCOL,
    electronDir: __dirname,
    frontendRoot: path.resolve(__dirname, "..", ".."),
    hardResetMutableHomePaths: HARD_RESET_MUTABLE_HOME_PATHS,
    isDev,
    sessionPartition: STELLA_SESSION_PARTITION,
    startupStageDelayMs: STARTUP_STAGE_DELAY_MS,
  });

  if (!initializeBootstrapSingleInstance(context)) {
    return;
  }

  registerBootstrapLifecycle(context);
};
