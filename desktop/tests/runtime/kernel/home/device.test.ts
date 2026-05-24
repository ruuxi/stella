import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getDeviceRecordPath,
  getOrCreateDeviceIdentity,
  resetDeviceIdentity,
} from "../../../../../runtime/kernel/home/device.js";

const roots = new Set<string>();
const originalDevStorage = process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE;

const createTempDir = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-device-"));
  roots.add(root);
  return root;
};

const readDeviceRecord = async (root: string) =>
  JSON.parse(await readFile(getDeviceRecordPath(root), "utf-8")) as {
    deviceId: string;
    publicKey?: string;
    privateKeyProtected?: string;
  };

beforeEach(() => {
  process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE = "1";
});

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
  if (originalDevStorage === undefined) {
    delete process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE;
  } else {
    process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE = originalDevStorage;
  }
});

describe("device identity", () => {
  it("reuses a readable persisted identity", async () => {
    const root = await createTempDir();

    const first = await getOrCreateDeviceIdentity(root);
    const second = await getOrCreateDeviceIdentity(root);

    expect(second.deviceId).toBe(first.deviceId);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.privateKey).toBe(first.privateKey);
  });

  it("does not reuse a device id when the persisted private key is unreadable", async () => {
    const root = await createTempDir();
    await writeFile(
      getDeviceRecordPath(root),
      JSON.stringify(
        {
          deviceId: "old-device",
          publicKey: "old-public-key",
          privateKeyProtected:
            "stella-protected:device-private-key:v1:not-readable-here",
        },
        null,
        2,
      ),
    );

    const identity = await getOrCreateDeviceIdentity(root);
    const stored = await readDeviceRecord(root);

    expect(identity.deviceId).not.toBe("old-device");
    expect(stored.deviceId).toBe(identity.deviceId);
    expect(stored.publicKey).toBe(identity.publicKey);
  });

  it("resets to a fresh device id on demand", async () => {
    const root = await createTempDir();

    const first = await getOrCreateDeviceIdentity(root);
    const second = await resetDeviceIdentity(root);

    expect(second.deviceId).not.toBe(first.deviceId);
    expect(second.publicKey).not.toBe(first.publicKey);
  });
});
