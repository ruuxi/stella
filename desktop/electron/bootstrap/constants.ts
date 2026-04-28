export const STELLA_APP_NAME = "Stella";
export const STELLA_WINDOWS_APP_USER_MODEL_ID = "com.stella.app";
export const AUTH_PROTOCOL = "Stella";
export const STELLA_SESSION_PARTITION = "persist:Stella";
export const STARTUP_STAGE_DELAY_MS = 250;
export const HARD_RESET_MUTABLE_HOME_PATHS = [
  "electron-user-data",
  "office-previews",
  "raw",
  "tmp",
  "skills/user-profile",
  "core-memory.md",
  "device.json",
  "local-scheduler.json",
  "stella.sqlite",
  "stella.sqlite-shm",
  "stella.sqlite-wal",
] as const;
