/**
 * Persistent media studio state — localStorage-backed history + form state.
 */

/* ── Types ── */

export type OutputMedia =
  | { kind: "image"; urls: string[]; localPaths?: string[] }
  | { kind: "video"; url: string; localPath?: string }
  | { kind: "audio"; url: string; localPath?: string }
  | { kind: "text"; text: string }
  | { kind: "download"; url: string; label: string; localPath?: string }
  | { kind: "unknown" }

export type HistoryEntry = {
  id: string
  capability: string
  capabilityName: string
  prompt?: string
  timestamp: number
  output: OutputMedia | null
  thumb?: string          // small data URL for the strip (kept in localStorage)
  status: "pending" | "succeeded" | "failed"
  error?: string
}

export type FormState = {
  category: string
  capabilityId: string | null
  prompt: string
  aspectRatio: string | null
  profile: string | null
  extraValues: Record<string, number>
}

/* ── Keys ── */

const HISTORY_KEY = "stella-media-history"
const FORM_KEY = "stella-media-form"
const MAX_HISTORY = 100

/* ── History ── */

export function loadHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]")
  } catch {
    return []
  }
}

export function saveHistory(entries: HistoryEntry[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)))
}

export function addHistoryEntry(entry: HistoryEntry): HistoryEntry[] {
  const entries = [entry, ...loadHistory().filter((e) => e.id !== entry.id)]
  saveHistory(entries)
  return entries
}

export function updateHistoryEntry(
  id: string,
  patch: Partial<HistoryEntry>,
): HistoryEntry[] {
  const entries = loadHistory().map((e) =>
    e.id === id ? { ...e, ...patch } : e,
  )
  saveHistory(entries)
  return entries
}

/* ── Form state ── */

const DEFAULT_FORM: FormState = {
  category: "image",
  capabilityId: null,
  prompt: "",
  aspectRatio: null,
  profile: null,
  extraValues: {},
}

export function loadFormState(): FormState {
  try {
    const raw = localStorage.getItem(FORM_KEY)
    if (!raw) return DEFAULT_FORM
    return { ...DEFAULT_FORM, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_FORM
  }
}

export function saveFormState(state: FormState): void {
  localStorage.setItem(FORM_KEY, JSON.stringify(state))
}

/* ── Output extraction ── */

export function extractOutput(output: unknown): OutputMedia {
  if (!output || typeof output !== "object") return { kind: "unknown" }
  const o = output as Record<string, unknown>

  if (Array.isArray(o.images) && o.images.length > 0) {
    const urls = (o.images as { url?: string }[])
      .map((img) => img.url)
      .filter((u): u is string => Boolean(u))
    if (urls.length > 0) return { kind: "image", urls }
  }

  if (o.video && typeof o.video === "object") {
    const url = (o.video as { url?: string }).url
    if (url) return { kind: "video", url }
  }

  for (const key of ["audio_file", "audio"]) {
    const src = o[key]
    if (src && typeof src === "object") {
      const url = (src as { url?: string }).url
      if (url) return { kind: "audio", url }
    }
  }

  if (typeof o.text === "string") return { kind: "text", text: o.text }

  if (o.model_mesh && typeof o.model_mesh === "object") {
    const url = (o.model_mesh as { url?: string }).url
    if (url) return { kind: "download", url, label: "Download 3D model" }
  }

  for (const val of Object.values(o)) {
    if (val && typeof val === "object" && "url" in (val as Record<string, unknown>)) {
      const url = (val as { url: string }).url
      if (url) return { kind: "download", url, label: "Download result" }
    }
  }

  return { kind: "unknown" }
}

/* ── Save output files to desktop/state ── */

export async function saveOutputToStella(
  output: OutputMedia,
  jobId: string,
): Promise<OutputMedia> {
  const saveApi = window.electronAPI?.media?.saveOutput
  if (!saveApi) return output

  const ext = (url: string) => {
    const m = url.match(/\.(\w{2,5})(?:[?#]|$)/)
    if (m) return m[1]
    if (output.kind === "image") return "png"
    if (output.kind === "video") return "mp4"
    if (output.kind === "audio") return "mp3"
    return "bin"
  }

  try {
    switch (output.kind) {
      case "image": {
        const results = await Promise.all(
          output.urls.map((url, i) => saveApi(url, `${jobId}_${i}.${ext(url)}`)),
        )
        const localPaths = results
          .filter((r) => r.ok && r.path)
          .map((r) => r.path!)
        return { ...output, localPaths }
      }
      case "video":
      case "audio":
      case "download": {
        const result = await saveApi(output.url, `${jobId}.${ext(output.url)}`)
        return result.ok && result.path ? { ...output, localPath: result.path } : output
      }
      default:
        return output
    }
  } catch {
    return output
  }
}

/* ── Thumbnail generation ── */

const THUMB_SIZE = 80

/** Downscale an image URL to a tiny JPEG data URL for localStorage. */
export function generateThumb(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => {
      const scale = Math.min(THUMB_SIZE / img.naturalWidth, THUMB_SIZE / img.naturalHeight, 1)
      const w = Math.round(img.naturalWidth * scale)
      const h = Math.round(img.naturalHeight * scale)
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      canvas.getContext("2d")!.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL("image/jpeg", 0.6))
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/* ── Open outputs folder ── */

export async function openOutputsFolder(): Promise<void> {
  const dir = await window.electronAPI?.media?.getStellaMediaDir()
  if (!dir) return
  // showItemInFolder needs a file, but we want the folder — create a
  // placeholder reference so the OS opens the directory.
  const folderPath = `${dir}${dir.includes("\\") ? "\\" : "/"}outputs`
  window.electronAPI?.system?.showItemInFolder(folderPath)
}
