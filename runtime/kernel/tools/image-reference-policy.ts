import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";

import type { ToolContext } from "./types.js";
import { decodeAndValidateImage } from "./image-decode-validation.js";

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
    context.stellaDataDir
      ? path.join(context.stellaDataDir, "fashion")
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

type ReferenceReadHooks = {
  /** Test-only race injection after the file descriptor is safely open. */
  afterOpen?: () => void | Promise<void>;
};

const sameOpenedObject = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const readBoundedFromHandle = async (
  handle: Awaited<ReturnType<typeof fs.open>>,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(
      Math.min(256 * 1024, MAX_IMAGE_REFERENCE_BYTES + 1 - total),
    );
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > MAX_IMAGE_REFERENCE_BYTES) {
      throw new Error(
        `reference image exceeds the ${MAX_IMAGE_REFERENCE_BYTES} byte limit`,
      );
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
};

export const readValidatedImageFileNoFollow = async (
  filePath: string,
  options: {
    allowedRoots?: readonly string[];
    hooks?: ReferenceReadHooks;
  } = {},
): Promise<AuthorizedImageReference> => {
  const requested = path.resolve(filePath);
  const initialResolved = await fs.realpath(requested);
  const roots = options.allowedRoots ?? [];
  if (
    roots.length > 0 &&
    !roots.some((root) => isWithin(initialResolved, root))
  ) {
    throw new Error("reference image is outside the authorized directories");
  }
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error(
      "safe no-follow image reads are unavailable on this platform",
    );
  }
  const handle = await fs.open(
    initialResolved,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      throw new Error("reference image is not a regular file");
    }
    if (openedStat.size <= 0 || openedStat.size > MAX_IMAGE_REFERENCE_BYTES) {
      throw new Error(
        `reference image must be between 1 byte and ${MAX_IMAGE_REFERENCE_BYTES} bytes`,
      );
    }
    await options.hooks?.afterOpen?.();
    const postOpenResolved = await fs.realpath(requested);
    if (
      roots.length > 0 &&
      !roots.some((root) => isWithin(postOpenResolved, root))
    ) {
      throw new Error(
        "reference image changed outside the authorized directories",
      );
    }
    const pathStat = await fs.stat(postOpenResolved);
    if (!sameOpenedObject(openedStat, pathStat)) {
      throw new Error("reference image changed while it was being authorized");
    }
    const bytes = await readBoundedFromHandle(handle);
    const finalStat = await handle.stat();
    if (
      !sameOpenedObject(openedStat, finalStat) ||
      bytes.length !== openedStat.size
    ) {
      throw new Error("reference image changed while it was being read");
    }
    const decoded = await decodeAndValidateImage(bytes);
    if (!decoded) {
      throw new Error(
        "reference file is not a complete, decodable PNG, JPEG, GIF, or WebP image",
      );
    }
    return { path: postOpenResolved, bytes, mimeType: decoded.mimeType };
  } finally {
    await handle.close();
  }
};

export const readAuthorizedImageReference = async (
  filePath: string,
  context: ToolContext,
  hooks?: ReferenceReadHooks,
): Promise<AuthorizedImageReference> => {
  const roots = await authorizedRoots(context);
  if (roots.length === 0) {
    throw new Error(
      "reference image is outside the active workspace or Stella attachment/media directories",
    );
  }
  return await readValidatedImageFileNoFollow(filePath, {
    allowedRoots: roots,
    ...(hooks ? { hooks } : {}),
  });
};

export const authorizedReferenceAsDataUri = async (
  filePath: string,
  context: ToolContext,
): Promise<string> => {
  const reference = await readAuthorizedImageReference(filePath, context);
  return `data:${reference.mimeType};base64,${reference.bytes.toString("base64")}`;
};

export const validateImageDataUri = async (value: string): Promise<void> => {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) throw new Error("reference data URI must be base64 encoded");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length <= 0 || bytes.length > MAX_IMAGE_REFERENCE_BYTES) {
    throw new Error(
      `reference data URI exceeds the ${MAX_IMAGE_REFERENCE_BYTES} byte limit`,
    );
  }
  const decoded = await decodeAndValidateImage(bytes);
  if (!decoded || decoded.mimeType !== match[1].trim().toLowerCase()) {
    throw new Error(
      "reference data URI MIME type does not match supported image bytes",
    );
  }
};
