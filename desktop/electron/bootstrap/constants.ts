export const STELLA_APP_NAME = "Stella";
export const STELLA_WINDOWS_APP_USER_MODEL_ID = "com.stella.app";
export const AUTH_PROTOCOL = "Stella";
export const STELLA_SESSION_PARTITION = "persist:Stella";
export const STARTUP_STAGE_DELAY_MS = 250;
export const HARD_RESET_MUTABLE_HOME_PATHS = [
  "state/electron-user-data",
  "state/office-previews",
  "state/raw",
  "state/tmp",
  "state/knowledge/user-profile",
  "state/core-memory.md",
  "state/device.json",
  "state/local-scheduler.json",
  "state/stella.sqlite",
  "state/stella.sqlite-shm",
  "state/stella.sqlite-wal",
] as const;
