import { promises as fs } from "fs";
import path from "path";
import { createPrivateKey, generateKeyPairSync, sign } from "crypto";
import { protectValue, unprotectValue } from "./protected_storage.js";

type DeviceRecord = {
  deviceId: string;
  publicKey?: string;
  privateKeyProtected?: string;
};

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

const DEVICE_FILE = "device.json";
const DEVICE_PRIVATE_KEY_SCOPE = "device-private-key";

export const getDeviceRecordPath = (statePath: string) =>
  path.join(statePath, DEVICE_FILE);

export const getOrCreateDeviceId = async (statePath: string) => {
  const identity = await getOrCreateDeviceIdentity(statePath);
  return identity.deviceId;
};

const generateDeviceKeyPair = (): Pick<DeviceIdentity, "publicKey" | "privateKey"> => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
  };
};

const toStoredDeviceRecord = (identity: DeviceIdentity): DeviceRecord => ({
  deviceId: identity.deviceId,
  publicKey: identity.publicKey,
  privateKeyProtected: protectValue(DEVICE_PRIVATE_KEY_SCOPE, identity.privateKey),
});

export const getOrCreateDeviceIdentity = async (
  statePath: string,
): Promise<DeviceIdentity> => {
  const recordPath = getDeviceRecordPath(statePath);
  let existingDeviceId: string | undefined;
  try {
    const raw = await fs.readFile(recordPath, "utf-8");
    const parsed = JSON.parse(raw) as DeviceRecord;
    existingDeviceId = parsed.deviceId;
    if (parsed.deviceId && parsed.publicKey && parsed.privateKeyProtected) {
      const decryptedPrivateKey = unprotectValue(
        DEVICE_PRIVATE_KEY_SCOPE,
        parsed.privateKeyProtected,
      );
      if (!decryptedPrivateKey) {
        throw new Error("Unable to decrypt persisted device private key.");
      }
      return {
        deviceId: parsed.deviceId,
        publicKey: parsed.publicKey,
        privateKey: decryptedPrivateKey,
      };
    }
  } catch {
    // Fall through to create.
  }

  const deviceId = existingDeviceId || crypto.randomUUID();
  const keyPair = generateDeviceKeyPair();
  const payload: DeviceIdentity = {
    deviceId,
    ...keyPair,
  };
  const record = toStoredDeviceRecord(payload);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, JSON.stringify(record, null, 2), "utf-8");
  return payload;
};

export const signDeviceHeartbeat = (
  identity: DeviceIdentity,
  signedAtMs: number,
): string => {
  const privateKey = createPrivateKey({
    key: Buffer.from(identity.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const payload = Buffer.from(`${identity.deviceId}:${signedAtMs}`);
  const signature = sign(null, payload, privateKey);
  return signature.toString("base64");
};
