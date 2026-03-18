const GAME_AUTH_PRIVATE_KEY_ENV = "STELLA_GAME_AUTH_PRIVATE_KEY";
const GAME_AUTH_ISSUER = "stella-game";
const GAME_AUTH_AUDIENCE = "stella-hosted-game";
const GAME_AUTH_VERSION = 1;
const GAME_AUTH_TTL_MS = 5 * 60 * 1000;

export type StellaGameAuthPayload = {
  v: number;
  iss: string;
  aud: string;
  sub: string;
  gameId: string;
  joinCode: string;
  spacetimeSessionId?: string;
  displayName: string;
  isAnonymous: false;
  iat: number;
  exp: number;
  jti: string;
};

const encoder = new TextEncoder();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function importPrivateKey(): Promise<CryptoKey> {
  const privateKeyBytes = base64ToBytes(requireEnv(GAME_AUTH_PRIVATE_KEY_ENV));
  return await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes.buffer as ArrayBuffer,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

export async function signHostedGameToken(args: {
  userId: string;
  gameId: string;
  joinCode: string;
  spacetimeSessionId?: string;
  displayName: string;
}): Promise<{ token: string; payload: StellaGameAuthPayload }> {
  const issuedAt = Date.now();
  const payload: StellaGameAuthPayload = {
    v: GAME_AUTH_VERSION,
    iss: GAME_AUTH_ISSUER,
    aud: GAME_AUTH_AUDIENCE,
    sub: args.userId,
    gameId: args.gameId,
    joinCode: args.joinCode,
    ...(args.spacetimeSessionId ? { spacetimeSessionId: args.spacetimeSessionId } : {}),
    displayName: args.displayName,
    isAnonymous: false,
    iat: issuedAt,
    exp: issuedAt + GAME_AUTH_TTL_MS,
    jti: crypto.randomUUID(),
  };

  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const key = await importPrivateKey();
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key,
    payloadBytes.buffer as ArrayBuffer,
  );

  return {
    token: `${toBase64Url(payloadBytes)}.${toBase64Url(new Uint8Array(signature))}`,
    payload,
  };
}

