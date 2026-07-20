import { promises as fs } from "node:fs";
import path from "node:path";

import type { ToolContext } from "./types.js";

export const MAX_IMAGE_REFERENCE_BYTES = 20 * 1024 * 1024;

const IMAGE_SIGNATURES: Array<{
  mimeType: string;
  matches: (bytes: Buffer) => boolean;
}> = [
  {
    mimeType: "image/png",
    matches: (bytes) =>
      bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  },
  {
    mimeType: "image/jpeg",
    matches: (bytes) =>
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    mimeType: "image/gif",
    matches: (bytes) =>
      ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")),
  },
  {
    mimeType: "image/webp",
    matches: (bytes) =>
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

export const detectSupportedImageMimeType = (bytes: Buffer): string | null =>
  IMAGE_SIGNATURES.find((entry) => entry.matches(bytes))?.mimeType ?? null;

const isWithin = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const authorizedRoots = async (context: ToolContext): Promise<string[]> => {
  const configured = [
    context.toolWorkspaceRoot,
    context.stellaDataDir
      ? path.join(context.stellaDataDir, "attachments")
      : undefined,
    context.stellaDataDir
      ? path.join(context.stellaDataDir, "media")
      : undefined,
    context.stellaDataDir
      ? path.join(context.stellaDataDir, "outputs")
      : undefined,
  ].filter((value): value is string => Boolean(value?.trim()));
  const roots = await Promise.all(
    configured.map(
      async (root) => await fs.realpath(path.resolve(root)).catch(() => null),
    ),
  );
  return roots.filter((root): root is string => root !== null);
};

export type AuthorizedImageReference = {
  path: string;
  bytes: Buffer;
  mimeType: string;
};

export const readAuthorizedImageReference = async (
  filePath: string,
  context: ToolContext,
): Promise<AuthorizedImageReference> => {
  const resolved = await fs.realpath(path.resolve(filePath));
  const roots = await authorizedRoots(context);
  if (roots.length === 0 || !roots.some((root) => isWithin(resolved, root))) {
    throw new Error(
      "reference image is outside the active workspace or Stella attachment/media directories",
    );
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("reference image is not a regular file");
  if (stat.size <= 0 || stat.size > MAX_IMAGE_REFERENCE_BYTES) {
    throw new Error(
      `reference image must be between 1 byte and ${MAX_IMAGE_REFERENCE_BYTES} bytes`,
    );
  }
  const bytes = await fs.readFile(resolved);
  const mimeType = detectSupportedImageMimeType(bytes);
  if (!mimeType) {
    throw new Error(
      "reference file is not a supported PNG, JPEG, GIF, or WebP image",
    );
  }
  return { path: resolved, bytes, mimeType };
};

export const authorizedReferenceAsDataUri = async (
  filePath: string,
  context: ToolContext,
): Promise<string> => {
  const reference = await readAuthorizedImageReference(filePath, context);
  return `data:${reference.mimeType};base64,${reference.bytes.toString("base64")}`;
};

export const validateImageDataUri = (value: string): void => {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) throw new Error("reference data URI must be base64 encoded");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length <= 0 || bytes.length > MAX_IMAGE_REFERENCE_BYTES) {
    throw new Error(
      `reference data URI exceeds the ${MAX_IMAGE_REFERENCE_BYTES} byte limit`,
    );
  }
  const detected = detectSupportedImageMimeType(bytes);
  if (!detected || detected !== match[1].trim().toLowerCase()) {
    throw new Error(
      "reference data URI MIME type does not match supported image bytes",
    );
  }
};
