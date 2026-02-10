import { beforeEach, describe, expect, test } from "bun:test";
import {
  decryptSecret,
  decryptSecretIfNeeded,
  encryptSecret,
  isEncryptedSecretSerialized,
} from "../convex/data/secrets_crypto";

const TEST_MASTER_KEY_B64 = Buffer.alloc(32, 7).toString("base64");

describe("secrets crypto", () => {
  beforeEach(() => {
    process.env.STELLA_SECRETS_MASTER_KEY = TEST_MASTER_KEY_B64;
    process.env.STELLA_SECRETS_MASTER_KEY_VERSION = "3";
  });

  test("encrypt/decrypt roundtrip", async () => {
    const encrypted = await encryptSecret("super-secret");
    const serialized = JSON.stringify(encrypted);
    const plaintext = await decryptSecret(serialized);
    expect(plaintext).toBe("super-secret");
    expect(encrypted.keyVersion).toBe(3);
  });

  test("decryptSecretIfNeeded leaves plaintext unchanged", async () => {
    const plaintext = await decryptSecretIfNeeded("plain-value");
    expect(plaintext).toBe("plain-value");
  });

  test("isEncryptedSecretSerialized detects encrypted payload", async () => {
    const encrypted = await encryptSecret("another-secret");
    const serialized = JSON.stringify(encrypted);
    expect(isEncryptedSecretSerialized(serialized)).toBe(true);
    expect(isEncryptedSecretSerialized("plain-value")).toBe(false);
  });
});
