import { useCallback, useEffect } from "react";
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
  request?: { prompt?: string };
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
        createdAt: job.completedAt ?? job.updatedAt,
      };
    }
    default:
      return null;
  }
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
      markMediaJobMaterialized(job.jobId);
    })();
    return () => {
      cancelled = true;
    };
  }, [job]);

  const effectivePayload =
    materializedPayload?.kind === "media" &&
    materializedPayload.asset.kind === "image"
      ? ({ ...materializedPayload, presentation: payload.presentation } as const)
      : payload;

  if (effectivePayload.asset.kind !== "image") return null;

  const filePaths = effectivePayload.asset.filePaths;
  const { files, error, loading } = useDisplayFileBlobs(
    filePaths,
    "Image preview requires the Electron host runtime.",
  );
  const primaryFile = files[0] ?? null;
  const primaryPath = filePaths[0];

  const handleClick = useCallback(() => {
    if (effectivePayload.asset.kind !== "image" || filePaths.length === 0) return;
    displayTabs.openTab(payloadToTabSpec(effectivePayload));
  }, [effectivePayload, filePaths.length]);

  return (
    <button
      type="button"
      className="inline-generated-image-card"
      onClick={handleClick}
      title="Open in panel"
    >
      <span className="inline-generated-image-card__frame">
        {primaryFile ? (
          <img
            src={primaryFile.url}
            alt={
              effectivePayload.prompt ?? (primaryPath ? filenameOf(primaryPath) : "")
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
