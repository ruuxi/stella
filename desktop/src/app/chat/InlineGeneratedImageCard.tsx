import { useCallback, useEffect, useMemo, type CSSProperties } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import {
  markMediaJobMaterialized,
  publishMaterializedMediaPayload,
  useMaterializedMediaPayload,
  useMaterializedMediaPayloadSnapshot,
} from "@/app/media/use-media-materializer";
import { extractOutput, saveOutputToStella } from "@/app/media/media-store";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { useDisplayFileBlobs } from "@/shared/hooks/use-display-file-data";
import { displayTabs } from "@/shell/display/tab-store";
import { payloadToTabSpec } from "@/shell/display/payload-to-tab-spec";
import { notifyAssistantScrollFollowLayoutChange } from "@/shell/chat-scroll-follow";
import "./inline-generated-image-card.css";

type InlineGeneratedImagePayload = Extract<DisplayPayload, { kind: "media" }>;

type StripTileSpec = {
  key: string;
  payload: InlineGeneratedImagePayload;
  imageIndex: number;
  materializeJob: boolean;
};

const filenameOf = (filePath: string): string =>
  filePath.split(/[\\/]/).pop() ?? filePath;

type MediaJobLookup = {
  jobId: string;
  capability: string;
  request?: {
    prompt?: string;
    aspectRatio?: string;
    input?: Record<string, unknown>;
  };
  output?: unknown;
  status?: string;
  completedAt?: number;
  updatedAt: number;
} | null;

const normalizeNumImages = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  return rounded >= 1 ? Math.min(rounded, 4) : null;
};

const numImagesFromJobRequest = (
  input: Record<string, unknown> | undefined,
): number | null => normalizeNumImages(input?.num_images);

const mediaPayloadFromJob = async (
  job: Exclude<MediaJobLookup, null>,
): Promise<InlineGeneratedImagePayload | null> => {
  if (job.output === undefined) return null;
  const extracted = extractOutput(job.output);
  if (extracted.kind === "unknown") return null;
  const saved = await saveOutputToStella(extracted, job.jobId);
  switch (saved.kind) {
    case "image": {
      const filePaths = saved.localPaths?.filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
      if (!filePaths || filePaths.length === 0) return null;
      return {
        kind: "media",
        asset: { kind: "image", filePaths },
        jobId: job.jobId,
        capability: job.capability,
        ...(job.request?.prompt ? { prompt: job.request.prompt } : {}),
        ...(job.request?.aspectRatio
          ? { aspectRatio: job.request.aspectRatio }
          : {}),
        ...(requestedSizeFromInput(job.request?.input)
          ? { requestedSize: requestedSizeFromInput(job.request?.input)! }
          : {}),
        ...(numImagesFromJobRequest(job.request?.input)
          ? { numImages: numImagesFromJobRequest(job.request?.input)! }
          : {}),
        createdAt: job.completedAt ?? job.updatedAt,
      };
    }
    default:
      return null;
  }
};

const requestedSizeFromInput = (
  input: Record<string, unknown> | undefined,
): { width: number; height: number } | null => {
  const imageSize = input?.image_size;
  if (!imageSize || typeof imageSize !== "object") return null;
  const record = imageSize as Record<string, unknown>;
  const width =
    typeof record.width === "number" && Number.isFinite(record.width)
      ? Math.floor(record.width)
      : null;
  const height =
    typeof record.height === "number" && Number.isFinite(record.height)
      ? Math.floor(record.height)
      : null;
  return width !== null && height !== null && width > 0 && height > 0
    ? { width, height }
    : null;
};

const ratioFromAspectRatio = (
  aspectRatio: string | undefined,
): string | null => {
  if (!aspectRatio) return null;
  const match = aspectRatio
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return `${width} / ${height}`;
};

const previewAspectRatio = (
  payload: InlineGeneratedImagePayload,
  job: MediaJobLookup | undefined,
): string => {
  const requestedSize =
    payload.requestedSize ?? requestedSizeFromInput(job?.request?.input);
  if (requestedSize) return `${requestedSize.width} / ${requestedSize.height}`;
  return (
    ratioFromAspectRatio(payload.aspectRatio) ??
    ratioFromAspectRatio(job?.request?.aspectRatio) ??
    "4 / 3"
  );
};

const resolveImageCount = (
  payload: InlineGeneratedImagePayload,
  materializedPayload: DisplayPayload | null,
): number => {
  const materializedPaths =
    materializedPayload?.kind === "media" &&
    materializedPayload.asset.kind === "image"
      ? materializedPayload.asset.filePaths
      : [];
  const payloadPaths =
    payload.asset.kind === "image" ? payload.asset.filePaths : [];
  return Math.max(
    materializedPaths.length,
    payloadPaths.length,
    payload.numImages ?? 1,
    1,
  );
};

const buildStripTiles = (
  payloads: InlineGeneratedImagePayload[],
  materializedByJobId: ReadonlyMap<string, DisplayPayload>,
): StripTileSpec[] => {
  const tiles: StripTileSpec[] = [];
  let materializeAssigned = false;

  for (const payload of payloads) {
    const materializedPayload = payload.jobId
      ? (materializedByJobId.get(payload.jobId) ?? null)
      : null;
    const hasResolvedAssets =
      payload.asset.kind === "image" && payload.asset.filePaths.length > 0;
    const imageCount = resolveImageCount(payload, materializedPayload);

    for (let imageIndex = 0; imageIndex < imageCount; imageIndex += 1) {
      const needsMaterialize =
        !materializeAssigned &&
        Boolean(payload.jobId) &&
        !materializedPayload &&
        !hasResolvedAssets;
      tiles.push({
        key: `${payload.jobId ?? payload.createdAt}-${imageIndex}`,
        payload,
        imageIndex,
        materializeJob: needsMaterialize,
      });
      if (needsMaterialize) materializeAssigned = true;
    }
  }

  return tiles;
};

const countLoadedStripTiles = (
  tiles: StripTileSpec[],
  materializedByJobId: ReadonlyMap<string, DisplayPayload>,
): number => {
  let loaded = 0;
  for (const tile of tiles) {
    const materializedPayload = tile.payload.jobId
      ? (materializedByJobId.get(tile.payload.jobId) ?? null)
      : null;
    const payloadPath =
      tile.payload.asset.kind === "image"
        ? tile.payload.asset.filePaths[tile.imageIndex]
        : undefined;
    const materializedPath =
      materializedPayload?.kind === "media" &&
      materializedPayload.asset.kind === "image"
        ? materializedPayload.asset.filePaths[tile.imageIndex]
        : undefined;
    if (payloadPath || materializedPath) loaded += 1;
  }
  return loaded;
};

/** Renders every inline image for a turn in one row (strip or single card). */
export const InlineGeneratedImageStrip = ({
  payloads,
}: {
  payloads: InlineGeneratedImagePayload[];
}) => {
  const materializedByJobId = useMaterializedMediaPayloadSnapshot();
  const tiles = useMemo(
    () => buildStripTiles(payloads, materializedByJobId),
    [materializedByJobId, payloads],
  );

  if (tiles.length === 0) return null;

  const isStrip = tiles.length > 1;
  const loadedTileCount = countLoadedStripTiles(tiles, materializedByJobId);
  const isStripPending = isStrip && loadedTileCount === 0;

  return (
    <div
      className={
        isStrip
          ? `inline-generated-image-cards inline-generated-image-cards--strip${
              isStripPending
                ? " inline-generated-image-cards--strip-pending"
                : ""
            }`
          : "inline-generated-image-cards"
      }
      style={
        isStrip
          ? ({
              "--inline-generated-image-count": tiles.length,
            } as CSSProperties)
          : undefined
      }
      aria-label={isStrip ? "Generated images" : undefined}
      aria-busy={isStripPending ? true : undefined}
    >
      {isStripPending ? (
        <span className="inline-generated-image-cards__pending-label">
          Generating...
        </span>
      ) : null}
      {tiles.map((tile) => (
        <InlineGeneratedImageCard
          key={tile.key}
          payload={tile.payload}
          imageIndex={tile.imageIndex}
          materializeJob={tile.materializeJob}
          layout={isStrip ? "strip" : "single"}
          sharedStripPending={isStripPending}
        />
      ))}
    </div>
  );
};

export const InlineGeneratedImageCard = ({
  payload,
  imageIndex = 0,
  materializeJob = true,
  layout = "single",
  sharedStripPending = false,
}: {
  payload: InlineGeneratedImagePayload;
  imageIndex?: number;
  materializeJob?: boolean;
  layout?: "single" | "strip";
  sharedStripPending?: boolean;
}) => {
  const materializedPayload = useMaterializedMediaPayload(payload.jobId);
  const hasResolvedAssets =
    payload.asset.kind === "image" && payload.asset.filePaths.length > 0;
  const job = useQuery(
    api.media_jobs.getByJobId,
    payload.jobId &&
      materializeJob &&
      !materializedPayload &&
      !hasResolvedAssets
      ? { jobId: payload.jobId }
      : "skip",
  ) as MediaJobLookup | undefined;

  useEffect(() => {
    if (!materializeJob) return;
    if (!job || job.status !== "succeeded" || !job.output) return;
    let cancelled = false;
    void (async () => {
      const completedPayload = await mediaPayloadFromJob(job);
      if (cancelled || !completedPayload) return;
      publishMaterializedMediaPayload(completedPayload);
      displayTabs.openTab(payloadToTabSpec(completedPayload), {
        activate: false,
      });
      markMediaJobMaterialized(job.jobId);
    })();
    return () => {
      cancelled = true;
    };
  }, [job, materializeJob]);

  const effectivePayload = useMemo(() => {
    const merged =
      materializedPayload?.kind === "media" &&
      materializedPayload.asset.kind === "image"
        ? ({
            ...materializedPayload,
            presentation: payload.presentation,
            ...(payload.numImages ? { numImages: payload.numImages } : {}),
          } as const)
        : payload;

    if (merged.asset.kind !== "image") return merged;

    const payloadPath =
      payload.asset.kind === "image"
        ? payload.asset.filePaths[imageIndex]
        : undefined;
    const path = merged.asset.filePaths[imageIndex] ?? payloadPath ?? null;
    return {
      ...merged,
      asset: { kind: "image" as const, filePaths: path ? [path] : [] },
      imageIndex,
    };
  }, [imageIndex, materializedPayload, payload]);

  const isImage = effectivePayload.asset.kind === "image";
  const filePaths = isImage ? effectivePayload.asset.filePaths : [];
  const { files, error, loading } = useDisplayFileBlobs(
    filePaths,
    "Image preview requires the Electron host runtime.",
  );
  const primaryFile = files[0] ?? null;
  const primaryPath = filePaths[0];
  const frameStyle = {
    "--inline-generated-image-aspect-ratio": previewAspectRatio(
      effectivePayload,
      job,
    ),
  } as CSSProperties;

  const handleClick = useCallback(() => {
    if (!isImage || filePaths.length === 0) return;
    displayTabs.openTab(payloadToTabSpec(effectivePayload));
  }, [effectivePayload, filePaths.length, isImage]);

  if (!isImage) return null;

  const placeholderLabel = error
    ? "Could not load image"
    : loading || filePaths.length === 0
      ? "Generating image..."
      : "Image";

  return (
    <button
      type="button"
      className={
        primaryFile
          ? "inline-generated-image-card inline-generated-image-card--image"
          : `inline-generated-image-card${
              sharedStripPending
                ? " inline-generated-image-card--strip-slot"
                : ""
            }`
      }
      onClick={handleClick}
      title="Open in panel"
      aria-label={
        sharedStripPending
          ? undefined
          : layout === "strip" && !primaryFile
            ? placeholderLabel
            : undefined
      }
      tabIndex={sharedStripPending ? -1 : undefined}
    >
      <span
        className={
          primaryFile
            ? "inline-generated-image-card__frame inline-generated-image-card__frame--image"
            : "inline-generated-image-card__frame"
        }
        style={frameStyle}
      >
        {primaryFile ? (
          <img
            src={primaryFile.url}
            alt={
              effectivePayload.prompt ??
              (primaryPath ? filenameOf(primaryPath) : "")
            }
            className="inline-generated-image-card__image"
            onLoad={notifyAssistantScrollFollowLayoutChange}
          />
        ) : (
          <span
            className={
              sharedStripPending
                ? "inline-generated-image-card__placeholder inline-generated-image-card__placeholder--slot"
                : "inline-generated-image-card__placeholder"
            }
            aria-hidden={layout === "strip" || sharedStripPending}
          >
            {sharedStripPending || layout === "strip" ? null : placeholderLabel}
          </span>
        )}
      </span>
    </button>
  );
};
