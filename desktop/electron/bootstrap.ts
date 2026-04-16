import { app } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import {
  AUTH_PROTOCOL,
  HARD_RESET_MUTABLE_HOME_PATHS,
  STARTUP_STAGE_DELAY_MS,
  STELLA_APP_NAME,
  STELLA_SESSION_PARTITION,
  STELLA_WINDOWS_APP_USER_MODEL_ID,
} from "./bootstrap/constants.js";
import { createBootstrapContext } from "./bootstrap/context.js";
import {
  initializeBootstrapSingleInstance,
  registerBootstrapLifecycle,
} from "./bootstrap/lifecycle.js";
import { resolveRuntimeStatePath } from "../../runtime/kernel/home/stella-home.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.NODE_ENV === "development";

const installDevBrokenPipeGuards = () => {
  if (!isDev) {
    return;
  }

  const swallowBrokenPipe = (_error: Error & { code?: string }) => {
    // Dev-mode Electron inherits stdio from the runner process. If that parent
    // pipe disappears, logging should not crash the app.
  };

  process.stdout.on("error", swallowBrokenPipe);
  process.stderr.on("error", swallowBrokenPipe);
};

const configureDevUserDataPath = () => {
  if (!isDev) {
    return;
  }

  const devUserDataPath = path.join(
    resolveRuntimeStatePath(app),
    "electron-user-data",
  );
  app.setPath("userData", devUserDataPath);
  app.setPath("sessionData", path.join(devUserDataPath, "session-data"));
};

export const bootstrapMainProcess = () => {
  app.setName(STELLA_APP_NAME);
  installDevBrokenPipeGuards();
  configureDevUserDataPath();
  if (process.platform === "win32") {
    app.setAppUserModelId(STELLA_WINDOWS_APP_USER_MODEL_ID);
  }

  const context = createBootstrapContext({
    authProtocol: AUTH_PROTOCOL,
    electronDir: __dirname,
    stellaRoot: path.resolve(__dirname, "..", "..", "..", ".."),
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
