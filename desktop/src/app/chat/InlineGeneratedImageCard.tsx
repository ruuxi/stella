import { useCallback, useEffect, useMemo, type CSSProperties } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import {
  markMediaJobMaterialized,
  publishMaterializedMediaPayload,
  useMaterializedMediaPayload,
} from "@/app/media/use-media-materializer";
import { extractOutput, saveOutputToStella } from "@/app/media/media-store";
import type { DisplayPayload } from "@/shared/contracts/display-payload";
import { useDisplayFileBlobs } from "@/shared/hooks/use-display-file-data";
import { displayTabs } from "@/shell/display/tab-store";
import { payloadToTabSpec } from "@/shell/display/payload-to-tab-spec";
import "./inline-generated-image-card.css";

type InlineGeneratedImagePayload = Extract<DisplayPayload, { kind: "media" }>;

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

const mediaPayloadFromJob = async (
  job: Exclude<MediaJobLookup, null>,
): Promise<DisplayPayload | null> => {
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

export const InlineGeneratedImageCard = ({
  payload,
}: {
  payload: InlineGeneratedImagePayload;
}) => {
  const materializedPayload = useMaterializedMediaPayload(payload.jobId);
  const job = useQuery(
    api.media_jobs.getByJobId,
    payload.jobId && !materializedPayload ? { jobId: payload.jobId } : "skip",
  ) as MediaJobLookup | undefined;

  useEffect(() => {
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
  }, [job]);

  const effectivePayload = useMemo(
    () =>
      materializedPayload?.kind === "media" &&
      materializedPayload.asset.kind === "image"
        ? ({
            ...materializedPayload,
            presentation: payload.presentation,
          } as const)
        : payload,
    [materializedPayload, payload],
  );

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

  return (
    <button
      type="button"
      className={
        primaryFile
          ? "inline-generated-image-card inline-generated-image-card--image"
          : "inline-generated-image-card"
      }
      onClick={handleClick}
      title="Open in panel"
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
          />
        ) : (
          <span className="inline-generated-image-card__placeholder">
            {error
              ? "Could not load image"
              : loading || filePaths.length === 0
                ? "Generating image..."
                : "Image"}
          </span>
        )}
      </span>
      {filePaths.length > 1 && (
        <span className="inline-generated-image-card__count">
          {filePaths.length} images
        </span>
      )}
    </button>
  );
};
