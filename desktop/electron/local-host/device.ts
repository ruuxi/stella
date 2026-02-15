import { promises as fs } from "fs";
import path from "path";
import { createPrivateKey, generateKeyPairSync, sign } from "crypto";

type DeviceRecord = {
  deviceId: string;
  publicKey?: string;
  privateKey?: string;
};

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

const DEVICE_FILE = "device.json";

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

export const getOrCreateDeviceIdentity = async (
  statePath: string,
): Promise<DeviceIdentity> => {
  const recordPath = getDeviceRecordPath(statePath);
  try {
    const raw = await fs.readFile(recordPath, "utf-8");
    const parsed = JSON.parse(raw) as DeviceRecord;
    if (parsed.deviceId && parsed.publicKey && parsed.privateKey) {
      return {
        deviceId: parsed.deviceId,
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
      };
    }
    if (parsed.deviceId) {
      const keyPair = generateDeviceKeyPair();
      const upgraded: DeviceIdentity = {
        deviceId: parsed.deviceId,
        ...keyPair,
      };
      await fs.writeFile(recordPath, JSON.stringify(upgraded, null, 2), "utf-8");
      return upgraded;
    }
  } catch {
    // Fall through to create.
  }

  const deviceId = crypto.randomUUID();
  const keyPair = generateDeviceKeyPair();
  const payload: DeviceIdentity = {
    deviceId,
    ...keyPair,
  };
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, JSON.stringify(payload, null, 2), "utf-8");
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
