import { useState, useCallback, useRef, startTransition } from "react"
import { useQuery } from "convex/react"
import { api } from "@/convex/api"
import { createServiceRequest } from "@/infra/http/service-request"
import "./media-studio.css"

/* ── Capability catalog (mirrors backend) ── */

type Category = "image" | "audio" | "video" | "3d"

type ExtraField = {
  key: string
  label: string
  type: "number"
  default: number
  min?: number
  max?: number
}

type CapabilityDef = {
  id: string
  name: string
  description: string
  category: Category
  needsPrompt: boolean
  needsSource: boolean
  sourceAccept?: string
  sourceLabel?: string
  supportsAspectRatio: boolean
  extraFields?: ExtraField[]
  profiles?: { id: string; name: string }[]
}

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "image", label: "Image" },
  { id: "audio", label: "Audio" },
  { id: "video", label: "Video" },
  { id: "3d", label: "3D" },
]

const CAPABILITIES: CapabilityDef[] = [
  {
    id: "text_to_image",
    name: "Text to Image",
    description: "Generate images from a text prompt",
    category: "image",
    needsPrompt: true,
    needsSource: false,
    supportsAspectRatio: true,
    profiles: [
      { id: "best", name: "Best" },
      { id: "fast", name: "Fast" },
    ],
  },
  {
    id: "icon",
    name: "Icon Generator",
    description: "Icons, logos, and thumbnails from a prompt",
    category: "image",
    needsPrompt: true,
    needsSource: false,
    supportsAspectRatio: false,
  },
  {
    id: "image_edit",
    name: "Image Edit",
    description: "Edit an existing image with text instructions",
    category: "image",
    needsPrompt: true,
    needsSource: true,
    sourceAccept: "image/*",
    sourceLabel: "Source image",
    supportsAspectRatio: true,
  },
  {
    id: "sound_effects",
    name: "Sound Effects",
    description: "Generate Foley and sound effects from a description",
    category: "audio",
    needsPrompt: true,
    needsSource: false,
    supportsAspectRatio: false,
    extraFields: [
      { key: "duration_seconds", label: "Duration (seconds)", type: "number", default: 5, min: 1, max: 30 },
    ],
  },
  {
    id: "text_to_dialogue",
    name: "Text to Dialogue",
    description: "Turn script text into spoken dialogue audio",
    category: "audio",
    needsPrompt: true,
    needsSource: false,
    supportsAspectRatio: false,
  },
  {
    id: "speech_to_text",
    name: "Speech to Text",
    description: "Transcribe spoken audio into text",
    category: "audio",
    needsPrompt: false,
    needsSource: true,
    sourceAccept: "audio/*",
    sourceLabel: "Audio file",
    supportsAspectRatio: false,
  },
  {
    id: "image_to_video",
    name: "Image to Video",
    description: "Animate a still image into a short video",
    category: "video",
    needsPrompt: true,
    needsSource: true,
    sourceAccept: "image/*",
    sourceLabel: "Source image",
    supportsAspectRatio: true,
  },
  {
    id: "video_extend",
    name: "Video Extend",
    description: "Continue or extend a video clip",
    category: "video",
    needsPrompt: false,
    needsSource: true,
    sourceAccept: "video/*",
    sourceLabel: "Source video",
    supportsAspectRatio: false,
  },
  {
    id: "video_to_video",
    name: "Video to Video",
    description: "Transform a video with text instructions",
    category: "video",
    needsPrompt: true,
    needsSource: true,
    sourceAccept: "video/*",
    sourceLabel: "Source video",
    supportsAspectRatio: true,
    profiles: [
      { id: "reference", name: "Reference" },
      { id: "edit", name: "Edit" },
    ],
  },
  {
    id: "text_to_3d",
    name: "Text to 3D",
    description: "Generate a 3D model from a text prompt",
    category: "3d",
    needsPrompt: true,
    needsSource: false,
    supportsAspectRatio: false,
  },
]

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const

/* ── Service ── */

type GenerateResponse = {
  jobId: string
  capability: string
  profile: string
  status: string
}

async function generateMedia(body: Record<string, unknown>): Promise<GenerateResponse> {
  const { endpoint, headers } = await createServiceRequest("/api/media/v1/generate", {
    "Content-Type": "application/json",
  })
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `Generation failed (${res.status})`)
  }
  return res.json() as Promise<GenerateResponse>
}

/* ── Output helpers ── */

type OutputMedia =
  | { kind: "image"; urls: string[] }
  | { kind: "video"; url: string }
  | { kind: "audio"; url: string }
  | { kind: "text"; text: string }
  | { kind: "download"; url: string; label: string }
  | { kind: "unknown" }

function extractOutput(output: unknown): OutputMedia {
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

/* ── File read helper ── */

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error("Failed to read file"))
    reader.readAsDataURL(file)
  })
}

/* ── Component ── */

export default function MediaStudio() {
  const [category, setCategory] = useState<Category>("image")
  const [capabilityId, setCapabilityId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState("")
  const [sourceUri, setSourceUri] = useState<string | null>(null)
  const [sourceFileName, setSourceFileName] = useState<string | null>(null)
  const [aspectRatio, setAspectRatio] = useState<string | null>(null)
  const [profile, setProfile] = useState<string | null>(null)
  const [extraValues, setExtraValues] = useState<Record<string, number>>({})
  const [submitting, setSubmitting] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [dragging, setDragging] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCountRef = useRef(0)

  const capability = capabilityId
    ? CAPABILITIES.find((c) => c.id === capabilityId) ?? null
    : null

  const filteredCapabilities = CAPABILITIES.filter((c) => c.category === category)

  // Whether the current source is compatible with the active capability
  const sourceType = sourceUri
    ? /^data:image\//i.test(sourceUri) ? "image" : /^data:video\//i.test(sourceUri) ? "video" : /^data:audio\//i.test(sourceUri) ? "audio" : "other"
    : null
  const sourceCompatible = capability?.needsSource
    ? capability.sourceAccept?.startsWith(sourceType ?? "") ?? false
    : false

  const job = useQuery(
    api.media_jobs.getByJobId,
    activeJobId ? { jobId: activeJobId } : "skip",
  ) as Record<string, unknown> | null | undefined

  const jobStatus = (job?.status ?? null) as string | null
  const jobOutput = job?.output
  const jobError = job?.error as { message?: string } | undefined
  const output = jobOutput ? extractOutput(jobOutput) : null

  const isSourceImage = capability?.sourceAccept?.startsWith("image")

  const handleCategoryChange = useCallback((cat: Category) => {
    startTransition(() => {
      setCategory(cat)
      setCapabilityId(null)
      setPrompt("")
      setAspectRatio(null)
      setProfile(null)
      setExtraValues({})
      setError(null)
      setActiveJobId(null)
      // source intentionally kept — carries across modes
    })
  }, [])

  const handleCapabilitySelect = useCallback((id: string) => {
    const cap = CAPABILITIES.find((c) => c.id === id)
    startTransition(() => {
      setCapabilityId(id)
      setPrompt("")
      setAspectRatio(null)
      setError(null)
      setActiveJobId(null)
      setProfile(cap?.profiles?.[0]?.id ?? null)
      setExtraValues(
        Object.fromEntries(
          (cap?.extraFields ?? []).map((f) => [f.key, f.default]),
        ),
      )
      // source intentionally kept — carries across modes
    })
  }, [])

  const ingestFile = useCallback(async (file: File) => {
    try {
      const dataUri = await readFileAsDataUri(file)
      setSourceUri(dataUri)
      setSourceFileName(file.name)
      setError(null)
    } catch {
      setError("Failed to read file")
    }
  }, [])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) void ingestFile(file)
    },
    [ingestFile],
  )

  const handleClearSource = useCallback(() => {
    setSourceUri(null)
    setSourceFileName(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCountRef.current += 1
    if (dragCountRef.current === 1) setDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCountRef.current -= 1
    if (dragCountRef.current === 0) setDragging(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      dragCountRef.current = 0
      setDragging(false)
      const file = e.dataTransfer.files[0]
      if (file) void ingestFile(file)
    },
    [ingestFile],
  )

  const handleGenerate = useCallback(async () => {
    if (!capability) return

    setSubmitting(true)
    setError(null)
    setActiveJobId(null)

    try {
      const body: Record<string, unknown> = {
        capability: capability.id,
        input: { ...extraValues },
      }
      if (prompt.trim()) body.prompt = prompt.trim()
      if (sourceUri) body.source = sourceUri
      if (aspectRatio) body.aspectRatio = aspectRatio
      if (profile) body.profile = profile

      const result = await generateMedia(body)
      startTransition(() => {
        setActiveJobId(result.jobId)
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed")
    } finally {
      setSubmitting(false)
    }
  }, [capability, prompt, sourceUri, aspectRatio, profile, extraValues])

  const canSubmit =
    capability &&
    !submitting &&
    (!capability.needsPrompt || prompt.trim().length > 0) &&
    (!capability.needsSource || (sourceUri !== null && sourceCompatible))

  return (
    <div
      className={`ms ${dragging ? "ms--dragging" : ""}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* ── Left: controls ── */}
      <div className="ms-controls">
        <div className="ms-controls-header">
          <h1 className="ms-title"><em>Media</em></h1>
          <p className="ms-lead">Create images, audio, video, and 3D.</p>
        </div>

        <nav className="ms-categories">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`ms-category ${category === cat.id ? "ms-category--active" : ""}`}
              onClick={() => handleCategoryChange(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </nav>

        <div className="ms-controls-body">
          {/* Capability list */}
          <div className="ms-capabilities">
            {filteredCapabilities.map((cap) => (
              <button
                key={cap.id}
                type="button"
                className={`ms-capability ${capabilityId === cap.id ? "ms-capability--active" : ""}`}
                onClick={() => handleCapabilitySelect(cap.id)}
              >
                <span className="ms-capability-name">{cap.name}</span>
                <span className="ms-capability-desc">{cap.description}</span>
              </button>
            ))}
          </div>

          {/* Form */}
          {capability && (
            <>
              <hr className="ms-rule" />
              <div className="ms-form">
                {capability.profiles && capability.profiles.length > 1 && (
                  <div className="ms-field">
                    <label className="ms-label">Quality</label>
                    <div className="ms-tags">
                      {capability.profiles.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={`ms-tag ${profile === p.id ? "ms-tag--active" : ""}`}
                          onClick={() => setProfile(p.id)}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {capability.needsPrompt && (
                  <div className="ms-field">
                    <label className="ms-label">Prompt</label>
                    <textarea
                      className="ms-textarea"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder={`Describe what you'd like…`}
                      rows={3}
                    />
                  </div>
                )}

                {capability.needsSource && (
                  <div className="ms-field">
                    <label className="ms-label">{capability.sourceLabel ?? "Source file"}</label>
                    {sourceFileName && sourceCompatible ? (
                      <div className="ms-source-info">
                        {sourceType === "image" && sourceUri && (
                          <img src={sourceUri} alt="" className="ms-source-preview" />
                        )}
                        <span className="ms-source-name">{sourceFileName}</span>
                        <button type="button" className="ms-source-clear" onClick={handleClearSource}>✕</button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="ms-upload"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {sourceFileName ? "Choose a different file" : "Choose file or drop anywhere"}
                      </button>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={capability.sourceAccept}
                      onChange={handleFileChange}
                      className="ms-file-input"
                    />
                  </div>
                )}

                {capability.supportsAspectRatio && (
                  <div className="ms-field">
                    <label className="ms-label">Aspect ratio</label>
                    <div className="ms-tags">
                      {ASPECT_RATIOS.map((ar) => (
                        <button
                          key={ar}
                          type="button"
                          className={`ms-tag ${aspectRatio === ar ? "ms-tag--active" : ""}`}
                          onClick={() => setAspectRatio(aspectRatio === ar ? null : ar)}
                        >
                          {ar}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {capability.extraFields?.map((field) => (
                  <div key={field.key} className="ms-field">
                    <label className="ms-label">{field.label}</label>
                    <input
                      type="number"
                      className="ms-number-input"
                      value={extraValues[field.key] ?? field.default}
                      min={field.min}
                      max={field.max}
                      onChange={(e) => {
                        const val = Number(e.target.value)
                        setExtraValues((prev) => ({ ...prev, [field.key]: val }))
                      }}
                    />
                  </div>
                ))}

                <button
                  type="button"
                  className="ms-generate"
                  disabled={!canSubmit}
                  onClick={handleGenerate}
                >
                  {submitting ? "Submitting…" : "Generate"}
                </button>

                {error && <p className="ms-error">{error}</p>}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Right: output ── */}
      <div className="ms-output-panel">
        {dragging && (
          <div className="ms-drop-overlay">
            <div className="ms-drop-label">Drop file</div>
          </div>
        )}

        {!activeJobId && !dragging && (
          <div className="ms-empty">
            <div className="ms-empty-title">Your creation</div>
            <div className="ms-empty-desc">
              Pick a capability and generate — or drop a file anywhere to get started.
            </div>
          </div>
        )}

        {activeJobId && (jobStatus === "queued" || jobStatus === "running") && (
          <div className="ms-status">
            <span className="ms-status-dot" />
            <span className="ms-status-text">
              {jobStatus === "queued" ? "Waiting in queue…" : "Generating…"}
            </span>
          </div>
        )}

        {activeJobId && jobStatus === "failed" && (
          <p className="ms-error">{jobError?.message ?? "Generation failed"}</p>
        )}

        {activeJobId && jobStatus === "succeeded" && output && (
          <div className="ms-output">
            {output.kind === "image" && (
              <div className="ms-output-images">
                {output.urls.map((url, i) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer" className="ms-output-image-link">
                    <img src={url} alt={`Generated ${i + 1}`} className="ms-output-image" />
                  </a>
                ))}
              </div>
            )}
            {output.kind === "video" && (
              <video src={output.url} controls className="ms-output-video" />
            )}
            {output.kind === "audio" && (
              <audio src={output.url} controls className="ms-output-audio" />
            )}
            {output.kind === "text" && (
              <div className="ms-output-text"><p>{output.text}</p></div>
            )}
            {output.kind === "download" && (
              <a href={output.url} target="_blank" rel="noreferrer" className="ms-output-download">
                {output.label}
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
