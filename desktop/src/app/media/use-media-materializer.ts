/**
 * Subscribes to every succeeded media job for the current viewer and
 * materializes its outputs into `state/media/outputs/`. This is the single
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

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { useQuery } from "convex/react"
import { api } from "@/convex/api"
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state"
import type {
  DisplayPayload,
  MediaAsset,
} from "@/shared/contracts/display-payload"
import {
  extractOutput,
  saveOutputToStella,
  type OutputMedia,
} from "./media-store"

const MATERIALIZED_KEY = "stella-media-materialized-jobs"
const MATERIALIZED_CAP = 1000

const loadFromStorage = (): string[] => {
  if (typeof localStorage === "undefined") return []
  try {
    const raw = localStorage.getItem(MATERIALIZED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as string[] | { jobIds?: string[] }
    const ids = Array.isArray(parsed) ? parsed : parsed.jobIds
    return ids ?? []
  } catch {
    return []
  }
}

const persistToStorage = (ids: Set<string>): void => {
  if (typeof localStorage === "undefined") return
  try {
    const trimmed = Array.from(ids).slice(-MATERIALIZED_CAP)
    localStorage.setItem(MATERIALIZED_KEY, JSON.stringify(trimmed))
  } catch {
    // Best-effort; no-op on quota errors.
  }
}

// Module-scoped, mutated through `markMediaJobMaterialized` and the
// materializer hook. Sharing the same Set across both means no race window
// where one writer's mark is invisible to the other (which would happen if
// each side maintained its own `loadFromStorage()` snapshot).
const materializedJobs: Set<string> = new Set(loadFromStorage())
const materializedPayloadsByJobId = new Map<string, DisplayPayload>()
const materializedPayloadListeners = new Set<() => void>()

export const publishMaterializedMediaPayload = (payload: DisplayPayload): void => {
  if (payload.kind === "media" && payload.jobId) {
    materializedPayloadsByJobId.set(payload.jobId, payload)
  }
  for (const listener of materializedPayloadListeners) listener()
}

export const useMaterializedMediaPayload = (
  jobId: string | undefined,
): DisplayPayload | null =>
  useSyncExternalStore(
    (listener) => {
      materializedPayloadListeners.add(listener)
      return () => materializedPayloadListeners.delete(listener)
    },
    () => (jobId ? (materializedPayloadsByJobId.get(jobId) ?? null) : null),
    () => null,
  )

/**
 * Mark a jobId as already-handled so the materializer skips it. Use this
 * from any UI that materializes its own jobs (e.g. MediaStudio) so we don't
 * double-download or pop the workspace panel over the user's active surface.
 */
export const markMediaJobMaterialized = (jobId: string): void => {
  if (materializedJobs.has(jobId)) return
  materializedJobs.add(jobId)
  persistToStorage(materializedJobs)
}

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
  completedAt?: number
  updatedAt: number
  createdAt: number
}

type UseMediaMaterializerOptions = {
  onMaterialized: (payload: DisplayPayload) => void
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
          materializedJobs.add(job.jobId)
          persistToStorage(materializedJobs)

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
}
