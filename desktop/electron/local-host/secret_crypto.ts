import { protectValue, unprotectValue } from "./protected_storage.js";

const LOCAL_SECRET_SCOPE = "local-secret";

export const LOCAL_SECRET_KEY_VERSION = 3;

export const encryptLocalSecret = (plaintext: string): string =>
  protectValue(LOCAL_SECRET_SCOPE, plaintext);

export const decryptLocalSecret = (value: string): string | null =>
  unprotectValue(LOCAL_SECRET_SCOPE, value);
