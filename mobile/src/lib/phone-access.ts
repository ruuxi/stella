import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { assert, assertObject } from "./assert";
import { getJson, postJson } from "./http";
import type { DesktopBridgeStatus } from "../types";

const MOBILE_DEVICE_ID_KEY = "stella-mobile_phone-access/mobile-device-id";
const PREFERRED_DESKTOP_DEVICE_ID_KEY =
  "stella-mobile_phone-access/preferred-desktop-device-id";
const DESKTOP_ACCESS_KEY_PREFIX = "stella-mobile_phone-access/desktop/";

export type StoredPhoneAccess = {
  desktopDeviceId: string;
  mobileDeviceId: string;
  pairSecret: string;
  approvedAt: number;
};

const desktopAccessKey = (desktopDeviceId: string) =>
  `${DESKTOP_ACCESS_KEY_PREFIX}${desktopDeviceId}`;

const createMobileDeviceId = () => {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return randomUuid;
  }
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

const readStoredPhoneAccess = (
  value: string | null,
): StoredPhoneAccess | null => {
  if (!value) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (
    typeof record.desktopDeviceId !== "string" ||
    typeof record.mobileDeviceId !== "string" ||
    typeof record.pairSecret !== "string" ||
    typeof record.approvedAt !== "number"
  ) {
    return null;
  }

  return {
    desktopDeviceId: record.desktopDeviceId,
    mobileDeviceId: record.mobileDeviceId,
    pairSecret: record.pairSecret,
    approvedAt: record.approvedAt,
  };
};

const readPairingResult = (
  value: unknown,
): { desktopDeviceId: string; approvedAt: number; pairSecret: string } => {
  assertObject(value, "Pairing response must be an object.");
  assert(
    typeof value.desktopDeviceId === "string",
    "Pairing response is missing the desktop id.",
  );
  assert(
    typeof value.approvedAt === "number",
    "Pairing response is missing the approval time.",
  );
  assert(
    typeof value.pairSecret === "string",
    "Pairing response is missing the phone credential.",
  );
  return {
    desktopDeviceId: value.desktopDeviceId,
    approvedAt: value.approvedAt,
    pairSecret: value.pairSecret,
  };
};

function readDesktopBridgeStatus(value: unknown): DesktopBridgeStatus {
  assertObject(value, "Desktop bridge response must be an object.");
  assert(
    typeof value.available === "boolean",
    "Desktop bridge availability is required.",
  );
  assert(
    Array.isArray(value.baseUrls),
    "Desktop bridge URLs must be an array.",
  );
  for (const item of value.baseUrls) {
    assert(typeof item === "string", "Desktop bridge URL must be a string.");
  }
  assert(
    value.platform === undefined || typeof value.platform === "string",
    "Desktop bridge platform must be a string.",
  );
  assert(
    value.updatedAt === undefined || typeof value.updatedAt === "number",
    "Desktop bridge updatedAt must be a number.",
  );
  return {
    available: value.available,
    baseUrls: value.baseUrls,
    platform: value.platform ?? null,
    updatedAt: value.updatedAt ?? null,
  };
}

const readPlatformLabel = () => {
  switch (Platform.OS) {
    case "ios":
      return "iPhone";
    case "android":
      return "Android";
    default:
      return "Phone";
  }
};

export const buildPhoneAccessHeaders = (access: StoredPhoneAccess) => ({
  "X-Stella-Mobile-Device-Id": access.mobileDeviceId,
  "X-Stella-Mobile-Pair-Secret": access.pairSecret,
});

export async function getOrCreateMobileDeviceId() {
  const existing = await SecureStore.getItemAsync(MOBILE_DEVICE_ID_KEY);
  if (existing?.trim()) {
    return existing.trim();
  }

  const nextId = createMobileDeviceId();
  await SecureStore.setItemAsync(MOBILE_DEVICE_ID_KEY, nextId);
  return nextId;
}

export async function getPreferredPhoneAccess() {
  const preferredDesktopDeviceId = await SecureStore.getItemAsync(
    PREFERRED_DESKTOP_DEVICE_ID_KEY,
  );
  if (!preferredDesktopDeviceId?.trim()) {
    return null;
  }

  const stored = await SecureStore.getItemAsync(
    desktopAccessKey(preferredDesktopDeviceId.trim()),
  );
  return readStoredPhoneAccess(stored);
}

export async function clearStoredPhoneAccess(desktopDeviceId: string) {
  const key = desktopAccessKey(desktopDeviceId);
  await SecureStore.deleteItemAsync(key);

  const preferredDesktopDeviceId = await SecureStore.getItemAsync(
    PREFERRED_DESKTOP_DEVICE_ID_KEY,
  );
  if (preferredDesktopDeviceId?.trim() === desktopDeviceId) {
    await SecureStore.deleteItemAsync(PREFERRED_DESKTOP_DEVICE_ID_KEY);
  }
}

export async function completePhonePairing(args: {
  pairingCode: string;
  displayName?: string;
}) {
  const mobileDeviceId = await getOrCreateMobileDeviceId();
  const result = readPairingResult(
    await postJson("/api/mobile/pairing/complete", {
      pairingCode: args.pairingCode,
      mobileDeviceId,
      ...(args.displayName?.trim()
        ? { displayName: args.displayName.trim().slice(0, 64) }
        : {}),
      platform: readPlatformLabel(),
    }),
  );

  const access: StoredPhoneAccess = {
    desktopDeviceId: result.desktopDeviceId,
    mobileDeviceId,
    pairSecret: result.pairSecret,
    approvedAt: result.approvedAt,
  };

  await SecureStore.setItemAsync(
    desktopAccessKey(result.desktopDeviceId),
    JSON.stringify(access),
  );
  await SecureStore.setItemAsync(
    PREFERRED_DESKTOP_DEVICE_ID_KEY,
    result.desktopDeviceId,
  );

  return access;
}

export async function requestDesktopConnection(access: StoredPhoneAccess) {
  await postJson(
    "/api/mobile/desktop-bridge/request",
    { desktopDeviceId: access.desktopDeviceId },
    { headers: buildPhoneAccessHeaders(access) },
  );
}

export async function getDesktopBridgeStatus(desktopDeviceId?: string) {
  const query = desktopDeviceId
    ? `?desktopDeviceId=${encodeURIComponent(desktopDeviceId)}`
    : "";
  return readDesktopBridgeStatus(
    await getJson(`/api/mobile/desktop-bridge${query}`),
  );
}
