/**
 * Fashion IPC handlers.
 *
 * The user's body photo is intentionally local-only — we never round-trip raw
 * bytes through Convex storage. The renderer asks the user to pick an image
 * file, this layer copies it into `~/.stella/fashion/body.<ext>`, and the
 * Convex backend only learns there is a body photo (via `setBodyPhotoFlag`,
 * called separately from the renderer through the Convex client).
 *
 * The `getBodyPhotoDataUrl` channel exists so the renderer can render the
 * preview without giving the renderer process direct disk read access.
 */

import { execFile } from "node:child_process";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { BrowserWindow, dialog, type IpcMainInvokeEvent } from "electron";

import {
  IPC_FASHION_DELETE_BODY_PHOTO,
  IPC_FASHION_GET_BODY_PHOTO_DATA_URL,
  IPC_FASHION_GET_BODY_PHOTO_INFO,
  IPC_FASHION_GET_LOCAL_IMAGE_DATA_URL,
  IPC_FASHION_PICK_AND_SAVE_BODY_PHOTO,
  IPC_FASHION_PICK_TRY_ON_IMAGES,
  IPC_FASHION_START_OUTFIT_BATCH,
  IPC_FASHION_START_TRY_ON,
} from "../../src/shared/contracts/ipc-channels.js";
import type { StellaHostRunner } from "../stella-host-runner.js";
import {
  registerPrivilegedHandle,
  type PrivilegedIpcOptions,
} from "./privileged-ipc.js";
import { waitForConnectedRunner } from "./runtime-availability.js";
import {
  MAX_IMAGE_REFERENCE_BYTES,
  readValidatedImageFileNoFollow,
} from "../../../runtime/kernel/tools/image-reference-policy.js";
import {
  decodeAndValidateImage,
  validateDecodedImageFile,
} from "../../../runtime/kernel/tools/image-decode-validation.js";
import { materializeMediaArtifact } from "../../../runtime/kernel/tools/media-artifact-store.js";

type FashionHandlerOptions = PrivilegedIpcOptions & {
  getStellaAppDir: () => string | null;
  getStellaDataDir: () => string | null;
  getStellaHostRunner: () => StellaHostRunner | null;
  onStellaHostRunnerChanged?: (
    listener: (runner: StellaHostRunner | null) => void,
  ) => () => void;
};

export type FashionBodyPhotoInfo = {
  hasBodyPhoto: boolean;
  absolutePath?: string;
  mimeType?: string;
  updatedAt?: number;
};

const SUPPORTED_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "heic",
] as const;
const execFileAsync = promisify(execFile);
const SIPS_TIMEOUT_MS = 30_000;
type FashionConversionOptions = {
  sipsPath?: string;
  /** Test override; production always uses the 30-second ceiling. */
  timeoutMs?: number;
  execSips?: (
    executable: string,
    args: readonly string[],
    options: { timeout: number; killSignal: NodeJS.Signals; maxBuffer: number },
  ) => Promise<unknown>;
};

const EXT_MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
};

const fashionDir = (root: string) => path.join(root, "fashion");
const tryOnDir = (root: string) => path.join(fashionDir(root), "try-on");
const mediaOutputsDir = (root: string) => path.join(root, "media", "outputs");
const hiddenFashionConversationId = (root: string) =>
  `fashion:${Buffer.from(root).toString("base64url").slice(0, 24)}`;

const sameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const readPickedFileNoFollow = async (filePath: string): Promise<Buffer> => {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Safe no-follow image reads are unavailable.");
  }
  const handle = await fs.open(
    path.resolve(filePath),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > MAX_IMAGE_REFERENCE_BYTES
    ) {
      throw new Error(
        "Fashion images must be regular files no larger than 20 MB.",
      );
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(
        Math.min(256 * 1024, MAX_IMAGE_REFERENCE_BYTES + 1 - total),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_IMAGE_REFERENCE_BYTES) {
        throw new Error("Fashion images must be no larger than 20 MB.");
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const verification = Buffer.allocUnsafe(total);
    let verificationOffset = 0;
    while (verificationOffset < total) {
      const { bytesRead } = await handle.read(
        verification,
        verificationOffset,
        total - verificationOffset,
        verificationOffset,
      );
      if (bytesRead === 0) break;
      verificationOffset += bytesRead;
    }
    const after = await handle.stat();
    const result = Buffer.concat(chunks, total);
    if (
      after.nlink !== 1 ||
      !sameFile(before, after) ||
      total !== before.size ||
      verificationOffset !== total ||
      !result.equals(verification)
    ) {
      throw new Error("Fashion image changed while it was being read.");
    }
    return result;
  } finally {
    await handle.close();
  }
};

const isHeicBytes = (bytes: Buffer): boolean => {
  if (bytes.length < 12 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") {
    return false;
  }
  const brand = bytes.subarray(8, 12).toString("ascii");
  return ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand);
};

const convertHeicToJpeg = async (
  bytes: Buffer,
  directory: string,
  options: FashionConversionOptions = {},
): Promise<Buffer> => {
  if (process.platform !== "darwin") {
    throw new Error("HEIC conversion is available only on macOS.");
  }
  const sipsPath = options.sipsPath ?? "/usr/bin/sips";
  const timeoutMs = options.timeoutMs ?? SIPS_TIMEOUT_MS;
  await fs.access(sipsPath, constants.X_OK).catch(() => {
    throw new Error(
      "HEIC conversion is unavailable in this Stella environment.",
    );
  });
  await fs.mkdir(directory, { recursive: true });
  const token = randomUUID();
  const sourcePath = path.join(directory, `.heic-source-${token}.heic`);
  const outputPath = path.join(directory, `.heic-output-${token}.jpg`);
  const source = await fs.open(sourcePath, "wx", 0o600);
  try {
    await source.writeFile(bytes);
    await source.sync();
  } finally {
    await source.close();
  }
  try {
    await (options.execSips ?? execFileAsync)(
      sipsPath,
      ["-s", "format", "jpeg", sourcePath, "--out", outputPath],
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 256 * 1024,
      },
    ).catch((error) => {
      if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
        throw new Error("HEIC conversion exceeded its 30 second safety limit.");
      }
      throw new Error(
        `HEIC conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const converted = await readValidatedImageFileNoFollow(outputPath, {
      allowedRoots: [await fs.realpath(directory)],
    });
    if (converted.mimeType !== "image/jpeg") {
      throw new Error("HEIC conversion did not produce a complete JPEG image.");
    }
    return converted.bytes;
  } finally {
    await Promise.all([
      fs.unlink(sourcePath).catch(() => undefined),
      fs.unlink(outputPath).catch(() => undefined),
    ]);
  }
};

export const prepareFashionImage = async (
  sourcePath: string,
  directory: string,
  conversionOptions: FashionConversionOptions = {},
): Promise<{ bytes: Buffer; ext: "jpg" | "png" | "gif" | "webp" }> => {
  const bytes = await readPickedFileNoFollow(sourcePath);
  const sourceExt = path.extname(sourcePath).slice(1).toLowerCase();
  if (sourceExt === "heic" || isHeicBytes(bytes)) {
    if (!isHeicBytes(bytes)) throw new Error("Selected HEIC file is invalid.");
    return {
      bytes: await convertHeicToJpeg(bytes, directory, conversionOptions),
      ext: "jpg",
    };
  }
  const decoded = await decodeAndValidateImage(bytes);
  if (!decoded)
    throw new Error("Selected file is not a complete, decodable image.");
  const ext =
    decoded.mimeType === "image/jpeg"
      ? "jpg"
      : decoded.mimeType === "image/png"
        ? "png"
        : decoded.mimeType === "image/gif"
          ? "gif"
          : "webp";
  return { bytes, ext };
};

const mimeForPreparedExtension = (ext: string): string =>
  ext === "jpg" ? "image/jpeg" : `image/${ext}`;

const writePreparedFashionImage = async (
  filePath: string,
  prepared: Awaited<ReturnType<typeof prepareFashionImage>>,
): Promise<void> => {
  await materializeMediaArtifact({
    filePath,
    validateExisting: async (candidate) =>
      await validateDecodedImageFile(
        candidate,
        mimeForPreparedExtension(prepared.ext),
      ),
    producer: async () => prepared.bytes,
  });
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await fs.open(directory, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync();
  } catch (error) {
    if (
      !["EINVAL", "ENOTSUP", "EBADF"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw error;
    }
  } finally {
    await handle.close();
  }
};

const replaceBodyPhoto = async (
  root: string,
  prepared: Awaited<ReturnType<typeof prepareFashionImage>>,
): Promise<string> => {
  const directory = fashionDir(root);
  await fs.mkdir(directory, { recursive: true });
  const staged = path.join(
    directory,
    `.body-next-${randomUUID()}.${prepared.ext}`,
  );
  await writePreparedFashionImage(staged, prepared);
  const destination = path.join(directory, `body.${prepared.ext}`);
  try {
    await removeAllBodyPhotos(root);
    await fs.rename(staged, destination);
    await syncDirectory(directory);
    return destination;
  } finally {
    await fs.unlink(staged).catch(() => undefined);
  }
};

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
};

const findExistingBodyPhoto = async (
  root: string,
): Promise<{ absolutePath: string; ext: string } | null> => {
  const dir = fashionDir(root);
  for (const ext of SUPPORTED_EXTENSIONS) {
    const candidate = path.join(dir, `body.${ext}`);
    try {
      await fs.access(candidate);
      if (ext === "heic") {
        const prepared = await prepareFashionImage(candidate, dir);
        const absolutePath = await replaceBodyPhoto(root, prepared);
        return { absolutePath, ext: prepared.ext };
      }
      return { absolutePath: candidate, ext };
    } catch {
      // Try next extension.
    }
  }
  return null;
};

const removeAllBodyPhotos = async (root: string) => {
  const dir = fashionDir(root);
  await Promise.all(
    SUPPORTED_EXTENSIONS.map(async (ext) => {
      try {
        await fs.unlink(path.join(dir, `body.${ext}`));
      } catch {
        // Ignore missing files.
      }
    }),
  );
};

const isPathInside = (childPath: string, parentPath: string): boolean => {
  const relative = path.relative(parentPath, childPath);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
};

const assertAllowedLocalImagePath = (
  root: string,
  rawPath: unknown,
): string => {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error("Image path is required.");
  }
  const absolutePath = path.resolve(rawPath.trim());
  const allowedRoots = [
    fashionDir(root),
    tryOnDir(root),
    mediaOutputsDir(root),
  ].map((entry) => path.resolve(entry));
  if (
    !allowedRoots.some((allowedRoot) => isPathInside(absolutePath, allowedRoot))
  ) {
    throw new Error(
      "Image path is outside Fashion's allowed local image folders.",
    );
  }
  return absolutePath;
};

const HTTP_URL_RE = /^https?:\/\//i;

const normalizeImageUrls = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (!HTTP_URL_RE.test(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
};

/**
 * Copy each user-picked image into `~/.stella/fashion/try-on/<batchId>/N.<ext>`
 * so the runtime can reference it via `image_gen` referenceImagePaths
 * without granting it ad-hoc filesystem access. Source paths can sit
 * anywhere on disk; the destination is always under Fashion's allowed
 * local-image roots.
 */
export const stashTryOnImagePaths = async (
  root: string,
  batchId: string,
  rawPaths: unknown,
): Promise<string[]> => {
  if (!Array.isArray(rawPaths)) return [];
  const paths: string[] = [];
  for (const entry of rawPaths) {
    if (typeof entry === "string" && entry.trim()) paths.push(entry.trim());
  }
  if (paths.length === 0) return [];
  if (
    path.basename(batchId) !== batchId ||
    !/^[a-zA-Z0-9._-]+$/.test(batchId)
  ) {
    throw new Error("Fashion batch ID is invalid.");
  }
  const dir = path.join(tryOnDir(root), batchId);
  await fs.mkdir(dir, { recursive: true });
  const out: string[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const sourcePath = paths[index]!;
    const prepared = await prepareFashionImage(sourcePath, dir);
    const destPath = path.join(dir, `${index}.${prepared.ext}`);
    await writePreparedFashionImage(destPath, prepared);
    out.push(destPath);
  }
  return out;
};

const getBodyPhotoInfo = async (
  root: string,
): Promise<FashionBodyPhotoInfo> => {
  const found = await findExistingBodyPhoto(root);
  if (!found) return { hasBodyPhoto: false };
  const stat = await fs.stat(found.absolutePath);
  const mimeType = EXT_MIME_MAP[found.ext] ?? "application/octet-stream";
  return {
    hasBodyPhoto: true,
    absolutePath: found.absolutePath,
    mimeType,
    updatedAt: stat.mtimeMs,
  };
};

export const registerFashionHandlers = (options: FashionHandlerOptions) => {
  const requireRoot = () => {
    const root = options.getStellaDataDir();
    if (!root) throw new Error("Stella root not initialized.");
    return root;
  };
  const waitForRunner = (timeoutMs = 10_000) =>
    waitForConnectedRunner(options.getStellaHostRunner, {
      timeoutMs,
      unavailableMessage: "Fashion agent runtime is unavailable.",
      onRunnerChanged: options.onStellaHostRunnerChanged,
    });

  registerPrivilegedHandle(
    options,
    IPC_FASHION_GET_BODY_PHOTO_INFO,
    async () => {
      return await getBodyPhotoInfo(requireRoot());
    },
  );

  registerPrivilegedHandle(options, IPC_FASHION_DELETE_BODY_PHOTO, async () => {
    await removeAllBodyPhotos(requireRoot());
    return { ok: true } as const;
  });

  registerPrivilegedHandle(
    options,
    IPC_FASHION_PICK_AND_SAVE_BODY_PHOTO,
    async (event: IpcMainInvokeEvent) => {
      const root = requireRoot();
      const dir = fashionDir(root);
      await fs.mkdir(dir, { recursive: true });

      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const result = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, {
            title: "Pick your body photo",
            properties: ["openFile"],
            filters: [
              {
                name: "Image",
                extensions: [...SUPPORTED_EXTENSIONS],
              },
            ],
          })
        : await dialog.showOpenDialog({
            title: "Pick your body photo",
            properties: ["openFile"],
            filters: [
              {
                name: "Image",
                extensions: [...SUPPORTED_EXTENSIONS],
              },
            ],
          });

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true } as const;
      }

      const sourcePath = result.filePaths[0]!;
      const prepared = await prepareFashionImage(sourcePath, dir);
      await replaceBodyPhoto(root, prepared);

      const info = await getBodyPhotoInfo(root);
      return { canceled: false, info } as const;
    },
  );

  registerPrivilegedHandle(
    options,
    IPC_FASHION_GET_BODY_PHOTO_DATA_URL,
    async () => {
      const root = requireRoot();
      const found = await findExistingBodyPhoto(root);
      if (!found) return null;
      const allowedRoot = await fs.realpath(fashionDir(root));
      const image = await readValidatedImageFileNoFollow(found.absolutePath, {
        allowedRoots: [allowedRoot],
      });
      return `data:${image.mimeType};base64,${image.bytes.toString("base64")}`;
    },
  );

  registerPrivilegedHandle(
    options,
    IPC_FASHION_GET_LOCAL_IMAGE_DATA_URL,
    async (_event: IpcMainInvokeEvent, payload?: { path?: unknown }) => {
      const root = requireRoot();
      const filePath = assertAllowedLocalImagePath(root, payload?.path);
      const allowedRoots = await Promise.all(
        [fashionDir(root), tryOnDir(root), mediaOutputsDir(root)].map(
          async (candidate) => await fs.realpath(candidate).catch(() => null),
        ),
      );
      const image = await readValidatedImageFileNoFollow(filePath, {
        allowedRoots: allowedRoots.filter(
          (candidate): candidate is string => candidate !== null,
        ),
      });
      return `data:${image.mimeType};base64,${image.bytes.toString("base64")}`;
    },
  );

  registerPrivilegedHandle(
    options,
    IPC_FASHION_PICK_TRY_ON_IMAGES,
    async (event: IpcMainInvokeEvent) => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions = {
        title: "Pick clothes images",
        properties: ["openFile", "multiSelections"] as Array<
          "openFile" | "multiSelections"
        >,
        filters: [
          {
            name: "Image",
            extensions: [...SUPPORTED_EXTENSIONS],
          },
        ],
      };
      const result = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, paths: [] as string[] } as const;
      }
      return { canceled: false, paths: result.filePaths } as const;
    },
  );

  registerPrivilegedHandle(
    options,
    IPC_FASHION_START_TRY_ON,
    async (_event: IpcMainInvokeEvent, payload?: Record<string, unknown>) => {
      const root = requireRoot();
      const found = await findExistingBodyPhoto(root);
      if (!found) {
        throw new Error("Add a body photo before trying on clothes.");
      }

      const promptText =
        typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
      const batchId =
        typeof payload?.batchId === "string" && payload.batchId.trim()
          ? payload.batchId.trim()
          : `tryon-${Date.now().toString(36)}`;

      const stashedPaths = await stashTryOnImagePaths(
        root,
        batchId,
        payload?.imagePaths,
      );
      const imageUrls = normalizeImageUrls(payload?.imageUrls);

      if (stashedPaths.length === 0 && imageUrls.length === 0) {
        throw new Error(
          "Attach at least one image of the clothes you want to try on.",
        );
      }

      const referencePathLines = stashedPaths
        .map((p, i) => `  - ref_${i + 1}: ${p}`)
        .join("\n");
      const referenceUrlLines = imageUrls
        .map((u, i) => `  - url_${i + 1}: ${u}`)
        .join("\n");

      const promptLines = [
        "TRY-ON MODE — render exactly one outfit image and stop.",
        "Do NOT call FashionGetContext, FashionSearchProducts, or any product lookup. The user has already supplied the clothing references.",
        "",
        promptText
          ? `User request: ${promptText}`
          : "User request: put these clothes on the person in the body photo.",
        "",
        "Inputs:",
        `- bodyPhotoPath: ${found.absolutePath}`,
        `- batchId: ${batchId}`,
        stashedPaths.length > 0
          ? `- attachmentImagePaths:\n${referencePathLines}`
          : "",
        imageUrls.length > 0
          ? `- attachmentImageUrls:\n${referenceUrlLines}`
          : "",
        "",
        "Steps:",
        "1. Call FashionCreateOutfit with batchId, ordinal=0, themeLabel='Try-on', themeDescription set to a one-line summary of the user request, products=[] (empty array — there are no shoppable products in try-on mode), and tryOnPrompt set to the prompt you'll feed image_gen.",
        "2. Call image_gen with profile='fast', aspectRatio='3:4', referenceImagePaths=[bodyPhotoPath, ...attachmentImagePaths], referenceImageUrls=attachmentImageUrls.",
        "   The prompt MUST include: 'studio photo on a clean white background, full body, natural pose, the same person as the first reference image, wearing the clothes from the remaining reference images.'",
        "3. Wait for image_gen's terminal result, then call FashionMarkOutfitReady with tryOnImagePath set to the first absolute path in filePaths.",
        "4. If image_gen fails, call FashionMarkOutfitFailed with a one-line errorMessage. Stop after a single render — do not retry, do not generate more outfits.",
      ].filter(Boolean);

      const runner = await waitForRunner();
      const result = await runner.createBackgroundAgent({
        conversationId: hiddenFashionConversationId(root),
        description: "Render a Fashion try-on",
        prompt: promptLines.join("\n"),
        agentType: "fashion",
      });
      const threadId =
        (result as { threadId?: string; agentId?: string }).threadId ??
        (result as { threadId?: string; agentId?: string }).agentId;

      return {
        threadId,
        batchId,
        imagePaths: stashedPaths,
        imageUrls,
      };
    },
  );

  registerPrivilegedHandle(
    options,
    IPC_FASHION_START_OUTFIT_BATCH,
    async (_event: IpcMainInvokeEvent, payload?: Record<string, unknown>) => {
      const root = requireRoot();
      const found = await findExistingBodyPhoto(root);
      if (!found) {
        throw new Error("Upload a body photo before generating outfits.");
      }

      const prompt =
        typeof payload?.prompt === "string" && payload.prompt.trim()
          ? payload.prompt.trim()
          : "Generate a fresh fashion feed batch.";
      const count =
        typeof payload?.count === "number" && Number.isFinite(payload.count)
          ? Math.max(1, Math.min(12, Math.floor(payload.count)))
          : 5;
      const batchId =
        typeof payload?.batchId === "string" && payload.batchId.trim()
          ? payload.batchId.trim()
          : `fashion-${Date.now().toString(36)}`;
      const excludeProductIds = normalizeStringArray(
        payload?.excludeProductIds,
      );
      const seedHints = normalizeStringArray(payload?.seedHints);

      const promptLines = [
        "Build a fresh batch of distinct outfits for the user's Fashion feed.",
        "",
        "User request:",
        prompt,
        "",
        "Inputs:",
        `- bodyPhotoPath: ${found.absolutePath}`,
        `- batchId: ${batchId}`,
        `- count: ${count}`,
        excludeProductIds && excludeProductIds.length > 0
          ? `- excludeProductIds: ${excludeProductIds.join(", ")}`
          : "",
        seedHints && seedHints.length > 0
          ? `- seedHints: ${seedHints.join(", ")}`
          : "",
        "",
        "Always begin by calling `FashionGetContext` once. Then assemble each outfit slot-by-slot with `FashionSearchProducts`, register it via `FashionCreateOutfit`, render it via `image_gen` (with the body photo path as the first reference image and product imageUrls as the remaining references), and finalize via `FashionMarkOutfitReady` / `FashionMarkOutfitFailed`.",
        "The try-on image must show the user wearing the selected clothes on a clean white studio background. The Fashion tab will render the generated image and surround it with the actual product images.",
      ].filter(Boolean);

      const runner = await waitForRunner();
      const result = await runner.createBackgroundAgent({
        conversationId: hiddenFashionConversationId(root),
        description: "Build a Fashion outfit batch",
        prompt: promptLines.join("\n"),
        agentType: "fashion",
      });
      const threadId =
        (result as { threadId?: string; agentId?: string }).threadId ??
        (result as { threadId?: string; agentId?: string }).agentId;

      return {
        threadId,
        batchId,
      };
    },
  );
};
