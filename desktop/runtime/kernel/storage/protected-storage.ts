// Re-export from shared location to avoid circular dependency between storage/ and home/.
// Canonical location: ../shared/protected-storage.ts
export { protectValue, unprotectValue } from "../shared/protected-storage.js";
