#!/usr/bin/env node
/**
 * fetch-pets.mjs — sync the public Codex Pet Share catalog into our R2
 * `stella-emotes` bucket and emit a local manifest the desktop app can
 * import at build time.
 *
 * The catalog lives at https://codex-pet-share.pages.dev (a public
 * Supabase-backed function). Each pet ships a 1536×1872 webp sprite
 * sheet and a small `pet.json` manifest. We:
 *
 *   1. Page through `GET /api/pets?content=all` until the listing is
 *      exhausted.
 *   2. For each pet, HEAD the existing R2 key first; if the size and
 *      ETag match, skip the upload (idempotent re-runs).
 *   3. Otherwise download the sprite sheet from the share API and PUT
 *      it to `pets/<id>.webp` via S3-compatible sigv4.
 *   4. Write `desktop/public/pets/manifest.json` with the metadata the
 *      pet picker / overlay needs (id, displayName, description, kind,
 *      tags, ownerName, public sprite URL).
 *
 * Required env (mirrors `convex env list` keys):
 *
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_ENDPOINT           e.g. https://<acct>.r2.cloudflarestorage.com
 *   R2_PUBLIC_BASE_URL    e.g. https://pub-…r2.dev (public hostname)
 *   R2_PETS_BUCKET        defaults to "stella-emotes"
 *   R2_PETS_PREFIX        defaults to "pets"
 *
 * Usage:
 *   bun run scripts/fetch-pets.mjs
 *   bun run scripts/fetch-pets.mjs --limit=20  # smoke test
 *   bun run scripts/fetch-pets.mjs --force      # re-upload everything
 */

import { createHash, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DESKTOP_ROOT = path.resolve(__dirname, "..");
const PUBLIC_PETS_DIR = path.join(DESKTOP_ROOT, "public", "pets");
const MANIFEST_PATH = path.join(PUBLIC_PETS_DIR, "manifest.json");
const SRC_PETS_DATA_DIR = path.join(DESKTOP_ROOT, "src", "shell", "pet", "data");
const SRC_MANIFEST_PATH = path.join(SRC_PETS_DATA_DIR, "manifest.json");

const PETSHARE_BASE =
  "https://ihzwckyzfcuktrljwpha.supabase.co/functions/v1/petshare";
const DEFAULT_BUCKET = process.env.R2_PETS_BUCKET || "stella-emotes";
const DEFAULT_PREFIX = (process.env.R2_PETS_PREFIX || "pets").replace(
  /^\/+|\/+$/g,
  "",
);
const DEFAULT_PUBLIC_BASE =
  process.env.R2_PUBLIC_BASE_URL ||
  "https://pub-58708621bfa94e3bb92de37cde354c0d.r2.dev";
const PAGE_SIZE = 50;
const UPLOAD_CONCURRENCY = 6;

const parseArgs = () => {
  const out = { limit: Infinity, force: false };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--force") out.force = true;
    else if (arg.startsWith("--limit=")) {
      out.limit = Number(arg.slice("--limit=".length));
    }
  }
  return out;
};

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it from \`bunx convex env list\` (run inside backend/).`,
    );
  }
  return value;
};

const sha256Hex = (data) =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** Build an AWS sigv4 signed PUT request against the R2 S3-compatible API. */
const signR2Put = ({
  accessKeyId,
  secretAccessKey,
  endpoint,
  bucket,
  key,
  body,
  contentType,
  cacheControl,
}) => {
  const url = new URL(`${endpoint.replace(/\/+$/, "")}/${bucket}/${key}`);
  const region = "auto";
  const service = "s3";
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .replace(/Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const headersToSign = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "content-type": contentType,
    "cache-control": cacheControl,
  };
  const signedHeaderKeys = Object.keys(headersToSign).sort();
  const canonicalHeaders =
    signedHeaderKeys.map((k) => `${k}:${headersToSign[k].trim()}`).join("\n") +
    "\n";
  const signedHeaders = signedHeaderKeys.join(";");

  const canonicalRequest = [
    "PUT",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: url.toString(),
    headers: {
      ...headersToSign,
      authorization,
    },
  };
};

const fetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
};

const fetchBuffer = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

const headR2Object = async ({ accessKeyId, secretAccessKey, endpoint, bucket, key }) => {
  const url = new URL(`${endpoint.replace(/\/+$/, "")}/${bucket}/${key}`);
  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "")
    .replace(/Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex("");
  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders =
    signedHeaderKeys.map((k) => `${k}:${headers[k].trim()}`).join("\n") + "\n";
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalRequest = [
    "HEAD",
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, "auto");
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");
  const auth = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const res = await fetch(url, {
    method: "HEAD",
    headers: { ...headers, authorization: auth },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`HEAD ${url} → ${res.status} ${await res.text()}`);
  }
  return {
    contentLength: Number(res.headers.get("content-length") ?? 0),
    etag: res.headers.get("etag") ?? null,
  };
};

const listAllPets = async ({ limit }) => {
  const collected = [];
  let page = 1;
  while (collected.length < limit) {
    const url = `${PETSHARE_BASE}/api/pets?content=all&pageSize=${PAGE_SIZE}&page=${page}`;
    const json = await fetchJson(url);
    if (!Array.isArray(json.pets) || json.pets.length === 0) break;
    for (const pet of json.pets) {
      if (collected.length >= limit) break;
      collected.push(pet);
    }
    if (collected.length >= (json.total ?? collected.length)) break;
    page += 1;
  }
  return collected;
};

const resolveSpritesheetUrl = (pet) => {
  if (typeof pet.spritesheetUrl !== "string" || !pet.spritesheetUrl) {
    return null;
  }
  if (pet.spritesheetUrl.startsWith("http")) return pet.spritesheetUrl;
  if (pet.spritesheetUrl.startsWith("/api/")) {
    return `${PETSHARE_BASE}${pet.spritesheetUrl}`;
  }
  return null;
};

const main = async () => {
  const { limit, force } = parseArgs();
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const endpoint = requireEnv("R2_ENDPOINT");
  const bucket = DEFAULT_BUCKET;
  const prefix = DEFAULT_PREFIX;
  const publicBase = DEFAULT_PUBLIC_BASE.replace(/\/+$/, "");

  console.log(
    `[pets] target r2://${bucket}/${prefix}/  (public ${publicBase}/${prefix}/)`,
  );
  await mkdir(PUBLIC_PETS_DIR, { recursive: true });
  await mkdir(SRC_PETS_DATA_DIR, { recursive: true });

  const catalog = await listAllPets({ limit });
  console.log(`[pets] discovered ${catalog.length} pets`);

  const manifestEntries = [];
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  const queue = [...catalog];
  const workers = Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const pet = queue.shift();
      if (!pet) break;
      const id = String(pet.id);
      const remoteUrl = resolveSpritesheetUrl(pet);
      if (!remoteUrl) {
        console.warn(`[pets] ${id}: missing spritesheetUrl, skipping`);
        failed += 1;
        continue;
      }
      const key = `${prefix}/${id}.webp`;
      try {
        let body = null;
        if (!force) {
          const head = await headR2Object({
            accessKeyId,
            secretAccessKey,
            endpoint,
            bucket,
            key,
          });
          if (head && head.contentLength > 0) {
            skipped += 1;
            manifestEntries.push(buildManifestEntry(pet, publicBase, prefix));
            console.log(`[pets] ${id}: cached (${head.contentLength}b)`);
            continue;
          }
        }
        body = await fetchBuffer(remoteUrl);
        const signed = signR2Put({
          accessKeyId,
          secretAccessKey,
          endpoint,
          bucket,
          key,
          body,
          contentType: "image/webp",
          cacheControl: "public, max-age=31536000, immutable",
        });
        const res = await fetch(signed.url, {
          method: "PUT",
          headers: signed.headers,
          body,
        });
        if (!res.ok) {
          throw new Error(`PUT ${key} → ${res.status} ${await res.text()}`);
        }
        uploaded += 1;
        manifestEntries.push(buildManifestEntry(pet, publicBase, prefix));
        console.log(`[pets] ${id}: uploaded (${body.length}b)`);
      } catch (error) {
        failed += 1;
        console.error(
          `[pets] ${id}: failed — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  });
  await Promise.all(workers);

  manifestEntries.sort((a, b) => a.displayName.localeCompare(b.displayName));
  const manifest = {
    generatedAt: new Date().toISOString(),
    publicBaseUrl: `${publicBase}/${prefix}`,
    bucket,
    prefix,
    count: manifestEntries.length,
    pets: manifestEntries,
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(MANIFEST_PATH, manifestJson, "utf8");
  await writeFile(SRC_MANIFEST_PATH, manifestJson, "utf8");
  console.log(
    `[pets] done — ${uploaded} uploaded, ${skipped} cached, ${failed} failed; manifest at ${MANIFEST_PATH} and ${SRC_MANIFEST_PATH}`,
  );
};

const buildManifestEntry = (pet, publicBase, prefix) => {
  const id = String(pet.id);
  return {
    id,
    displayName: String(pet.displayName ?? id),
    description: String(pet.description ?? "").trim(),
    kind: typeof pet.kind === "string" ? pet.kind : "object",
    tags: Array.isArray(pet.tags) ? pet.tags.filter((t) => typeof t === "string") : [],
    ownerName:
      typeof pet.ownerName === "string" && pet.ownerName ? pet.ownerName : null,
    spritesheetUrl: `${publicBase}/${prefix}/${id}.webp`,
    sourceUrl: `https://codex-pet-share.pages.dev/#/pet/${id}`,
  };
};

main().catch((error) => {
  console.error(
    `[pets] fatal — ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
