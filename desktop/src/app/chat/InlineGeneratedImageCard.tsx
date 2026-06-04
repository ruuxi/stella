import {
  Suspense,
  lazy,
  useCallback,
  useMemo,
  type CSSProperties,
} from "react";
import {
  useMaterializedMediaPayload,
  useMaterializedMediaPayloadSnapshot,
} from "@/app/media/media-materializer-state";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { useDisplayFileBlobs } from "@/shared/hooks/use-display-file-data";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { notifyAssistantScrollFollowLayoutChange } from "@/shell/chat-scroll-follow";
import { friendlyImageGenerationFailure } from "@/app/media/media-error-copy";
import "./inline-generated-image-card.css";

export type InlineGeneratedImagePayload = Extract<DisplayPayload, { kind: "media" }>;

type StripTileSpec = {
  key: string;
  payload: InlineGeneratedImagePayload;
  imageIndex: number;
  materializeJob: boolean;
};

const filenameOf = (filePath: string): string =>
  filePath.split(/[\\/]/).pop() ?? filePath;

export type MediaJobLookup = {
  jobId: string;
  capability: string;
  request?: {
    prompt?: string;
    aspectRatio?: string;
    input?: Record<string, unknown>;
  };
  output?: unknown;
  status?: string;
  error?: {
    message?: string;
    code?: string;
  };
  completedAt?: number;
  updatedAt: number;
} | null;

export const requestedSizeFromInput = (
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
  conversationId,
}: {
  payloads: InlineGeneratedImagePayload[];
  conversationId?: string | null;
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
          conversationId={conversationId}
          imageIndex={tile.imageIndex}
          materializeJob={tile.materializeJob}
          layout={isStrip ? "strip" : "single"}
          sharedStripPending={isStripPending}
        />
      ))}
    </div>
  );
};

export type InlineGeneratedImageCardProps = {
  payload: InlineGeneratedImagePayload;
  imageIndex?: number;
  materializeJob?: boolean;
  layout?: "single" | "strip";
  sharedStripPending?: boolean;
  conversationId?: string | null;
};

const LazyInlineGeneratedImageCardWithJob = lazy(() =>
  import("./InlineGeneratedImageCardWithJob").then((module) => ({
    default: module.InlineGeneratedImageCardWithJob,
  })),
);

const isMiniRenderer = (): boolean =>
  typeof document !== "undefined" &&
  document.documentElement.dataset.stellaWindow === "mini";

const needsRemoteJobLookup = ({
  payload,
  materializeJob = true,
}: InlineGeneratedImageCardProps): boolean =>
  Boolean(
    payload.jobId &&
      materializeJob &&
      payload.asset.kind === "image" &&
      payload.asset.filePaths.length === 0,
  );

export const InlineGeneratedImageCard = (props: InlineGeneratedImageCardProps) => {
  if (isMiniRenderer() || !needsRemoteJobLookup(props)) {
    return <InlineGeneratedImageCardLocal {...props} />;
  }

  return (
    <Suspense fallback={<InlineGeneratedImageCardLocal {...props} />}>
      <LazyInlineGeneratedImageCardWithJob {...props} />
    </Suspense>
  );
};

const InlineGeneratedImageCardLocal = (
  props: InlineGeneratedImageCardProps,
) => {
  const materializedPayload = useMaterializedMediaPayload(props.payload.jobId);
  return (
    <InlineGeneratedImageCardFrame
      {...props}
      job={undefined}
      materializedPayload={materializedPayload}
    />
  );
};

export const InlineGeneratedImageCardFrame = ({
  payload,
  imageIndex = 0,
  layout = "single",
  sharedStripPending = false,
  conversationId,
  job,
  materializedPayload,
}: InlineGeneratedImageCardProps & {
  job: MediaJobLookup | undefined;
  materializedPayload: DisplayPayload | null;
}) => {
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
    conversationId,
  );
  const primaryFile = files[0] ?? null;
  const primaryPath = filePaths[0];
  const jobFailed = job?.status === "failed" || job?.status === "canceled";
  const canOpenDisplayPanel = !isMiniRenderer();
  const frameStyle = {
    "--inline-generated-image-aspect-ratio": previewAspectRatio(
      effectivePayload,
      job,
    ),
  } as CSSProperties;

  const handleClick = useCallback(() => {
    if (!canOpenDisplayPanel || !isImage || filePaths.length === 0) return;
    openDisplayPayloadTab(effectivePayload);
  }, [canOpenDisplayPanel, effectivePayload, filePaths.length, isImage]);

  if (!isImage) return null;

  const placeholderLabel = error
    ? "Could not load image"
    : jobFailed
      ? friendlyImageGenerationFailure(job?.error)
      : loading || filePaths.length === 0
        ? "Generating image..."
        : "Image";
  const buttonClassName = primaryFile
    ? "inline-generated-image-card inline-generated-image-card--image"
    : `inline-generated-image-card${
        sharedStripPending ? " inline-generated-image-card--strip-slot" : ""
      }${jobFailed ? " inline-generated-image-card--failed" : ""}`;
  const frameClassName = primaryFile
    ? "inline-generated-image-card__frame inline-generated-image-card__frame--image"
    : `inline-generated-image-card__frame${
        jobFailed ? " inline-generated-image-card__frame--failed" : ""
      }`;
  const placeholderClassName = sharedStripPending
    ? "inline-generated-image-card__placeholder inline-generated-image-card__placeholder--slot"
    : `inline-generated-image-card__placeholder${
        jobFailed ? " inline-generated-image-card__placeholder--failed" : ""
      }`;

  return (
    <button
      type="button"
      className={buttonClassName}
      onClick={handleClick}
      title={
        jobFailed
          ? "Image generation failed"
          : canOpenDisplayPanel
            ? "Open in panel"
            : "Image"
      }
      aria-disabled={canOpenDisplayPanel ? undefined : true}
      aria-label={
        sharedStripPending
          ? undefined
          : (layout === "strip" && !primaryFile) || jobFailed
            ? placeholderLabel
            : undefined
      }
      tabIndex={sharedStripPending ? -1 : undefined}
    >
      <span className={frameClassName} style={frameStyle}>
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
            className={placeholderClassName}
            aria-hidden={layout === "strip" || sharedStripPending}
          >
            {sharedStripPending || layout === "strip" ? null : placeholderLabel}
          </span>
        )}
      </span>
    </button>
  );
};
