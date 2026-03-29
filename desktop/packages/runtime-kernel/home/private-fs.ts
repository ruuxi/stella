// Re-export from shared location to avoid circular dependency between home/ and storage/.
// Canonical location: ../shared/private-fs.ts
export {
  ensurePrivateDir,
  ensurePrivateDirSync,
  writePrivateFile,
  writePrivateFileSync,
} from "../shared/private-fs.js";
