/**
 * Subscribes to every succeeded media job for the current viewer and
 * materializes its outputs into `~/.stella/media/outputs/`. This is the single
 * place that turns a remote media job (started by MediaStudio, by the
 * agent's `MediaGenerate` tool, by a CLI, …) into a local file plus a
 * `DisplayPayload` the sidebar can render.
 *
 * Decoupling production from materialization is what makes "all generated
 * media auto-shows in the workspace panel" robust: it doesn't matter who
 * `curl`'d the managed media API — every job lives in `media_jobs` keyed by
 * `ownerId`, this hook drains the queue, and downstream UI subscribes to a
 * single payload stream.
 */

import { useEffect, useMemo, useRef } from "react"
import { useQuery } from "convex/react"
import { api } from "@/convex/api"
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state"
import type {
  DisplayPayload,
  DisplayTabPayload,
  MediaAsset,
} from "@/shared/contracts/display-payload"
import {
  extractOutput,
  saveOutputToStella,
  type OutputMedia,
} from "./media-store"
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload"
import { showToast } from "@/ui/toast"
import { friendlyImageGenerationFailure } from "./media-error-copy"
import {
  capInMemory,
  failedNotifiedJobs,
  markMediaJobMaterialized,
  materializedJobs,
  persistFailedNotifiedJobs,
  publishMaterializedMediaPayload,
} from "./media-materializer-state"

export {
  markMediaJobMaterialized,
  publishMaterializedMediaPayload,
  useMaterializedMediaPayload,
  useMaterializedMediaPayloadSnapshot,
} from "./media-materializer-state"

const toMediaAsset = (output: OutputMedia): MediaAsset | null => {
  switch (output.kind) {
    case "image": {
      const filePaths = output.localPaths?.filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      )
      if (!filePaths || filePaths.length === 0) return null
      return { kind: "image", filePaths }
    }
    case "video":
      if (!output.localPath) return null
      return { kind: "video", filePath: output.localPath }
    case "audio":
      if (!output.localPath) return null
      return { kind: "audio", filePath: output.localPath }
    case "download":
      if (!output.localPath) return null
      // Treat 3D-ish extensions as model3d; everything else stays as download.
      if (/\.(glb|gltf|obj|stl)$/i.test(output.localPath)) {
        return { kind: "model3d", filePath: output.localPath, label: output.label }
      }
      return {
        kind: "download",
        filePath: output.localPath,
        label: output.label,
      }
    case "text":
      return { kind: "text", text: output.text }
    case "unknown":
      return null
  }
}

type MaterializerJob = {
  jobId: string
  capability: string
  request?: { prompt?: string }
  output?: unknown
  error?: {
    message?: string
    code?: string
  }
  completedAt?: number
  updatedAt: number
  createdAt: number
}

const IMAGE_CAPABILITIES = new Set(["text_to_image", "image_edit", "icon"])

type UseMediaMaterializerOptions = {
  onMaterialized: (payload: DisplayTabPayload) => void
  /**
   * If true, suppress the `onMaterialized` dispatch (the file is still
   * downloaded to disk, but no payload is fired). Used when the user is
   * already on the `/media` route so we don't fight MediaStudio.
   */
  suppress?: boolean
}

/**
 * Mounts the global media materializer. Safe to call once at the root level.
 * The query is gated on auth; while signed-out it sits idle.
 */
export const useMediaMaterializer = ({
  onMaterialized,
  suppress = false,
}: UseMediaMaterializerOptions): void => {
  const { hasConnectedAccount } = useAuthSessionState()

  // Stable boot timestamp so we don't re-materialize the entire history on
  // every reload. We reach back ~10 minutes to forgive crashes/restarts that
  // happened during a long-running job.
  const bootSince = useMemo(() => Date.now() - 10 * 60 * 1000, [])

  const onPayloadRef = useRef(onMaterialized)
  onPayloadRef.current = onMaterialized
  const suppressRef = useRef(suppress)
  suppressRef.current = suppress

  const inFlightRef = useRef<Set<string>>(new Set())

  const jobs = useQuery(
    api.media_jobs.listSucceededSince,
    hasConnectedAccount ? { since: bootSince, limit: 50 } : "skip",
  ) as MaterializerJob[] | undefined

  const failedJobs = useQuery(
    api.media_jobs.listFailedSince,
    hasConnectedAccount ? { since: bootSince, limit: 50 } : "skip",
  ) as MaterializerJob[] | undefined

  useEffect(() => {
    if (!jobs || jobs.length === 0) return

    // Process oldest-first so multiple completions in one tick land in the
    // right order in the sidebar.
    const ordered = [...jobs].sort(
      (a, b) =>
        (a.completedAt ?? a.updatedAt) - (b.completedAt ?? b.updatedAt),
    )

    for (const job of ordered) {
      if (materializedJobs.has(job.jobId)) continue
      if (inFlightRef.current.has(job.jobId)) continue
      if (job.output === undefined) continue

      inFlightRef.current.add(job.jobId)

      void (async () => {
        try {
          const extracted = extractOutput(job.output)
          if (extracted.kind === "unknown") return

          const saved = await saveOutputToStella(extracted, job.jobId)
          const asset = toMediaAsset(saved)
          if (!asset) return

          const completedAt = job.completedAt ?? job.updatedAt
          const payload: DisplayPayload = {
            kind: "media",
            asset,
            jobId: job.jobId,
            capability: job.capability,
            ...(job.request?.prompt ? { prompt: job.request.prompt } : {}),
            createdAt: completedAt,
          }

          publishMaterializedMediaPayload(payload)
          markMediaJobMaterialized(job.jobId)

          if (payload.asset.kind === "image") {
            openDisplayPayloadTab(payload, {
              activate: false,
            })
          }

          if (!suppressRef.current) {
            onPayloadRef.current(payload)
          }
        } catch {
          // Swallow per-job errors; we'll retry on the next subscription
          // tick (entry stays out of the materialized set).
        } finally {
          inFlightRef.current.delete(job.jobId)
        }
      })()
    }
  }, [bootSince, jobs])

  useEffect(() => {
    if (!failedJobs || failedJobs.length === 0) return

    const ordered = [...failedJobs].sort(
      (a, b) =>
        (a.completedAt ?? a.updatedAt) - (b.completedAt ?? b.updatedAt),
    )

    for (const job of ordered) {
      if (!IMAGE_CAPABILITIES.has(job.capability)) continue
      if (failedNotifiedJobs.has(job.jobId)) continue
      failedNotifiedJobs.add(job.jobId)
      // Bound the in-memory set, matching the persist-time cap.
      capInMemory(failedNotifiedJobs)
      persistFailedNotifiedJobs()
      showToast({
        title: friendlyImageGenerationFailure(job.error),
        variant: "error",
      })
    }
  }, [failedJobs])
}
