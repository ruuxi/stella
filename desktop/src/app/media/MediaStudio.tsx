import { useState, useCallback, useRef, useEffect, useMemo, startTransition } from "react"
import { useQuery } from "convex/react"
import { api } from "@/convex/api"
import { createServiceRequest } from "@/infra/http/service-request"
import {
  type FormState,
  type HistoryEntry,
  type OutputMedia,
  addHistoryEntry,
  extractOutput,
  generateThumb,
  loadFormState,
  loadHistory,
  openOutputsFolder,
  saveFormState,
  saveOutputToStella,
  updateHistoryEntry,
} from "./media-store"
import { markMediaJobMaterialized } from "./use-media-materializer"
import "./media-studio.css"

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

/* ── Capability catalog ── */

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
    let message = `Generation failed (${res.status})`
    try {
      const json = await res.json() as { error?: string }
      if (json.error) message = json.error
    } catch {
      const text = await res.text().catch(() => "")
      if (text) message = text
    }
    throw new Error(message)
  }
  return res.json() as Promise<GenerateResponse>
}

/* ── File helpers ── */

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
  // Restore persisted state
  const [savedForm] = useState(loadFormState)
  const [history, setHistory] = useState(loadHistory)

  const [category, setCategory] = useState<Category>(savedForm.category as Category)
  const [capabilityId, setCapabilityId] = useState<string | null>(savedForm.capabilityId)
  const [prompt, setPrompt] = useState(savedForm.prompt)
  const [sourceUri, setSourceUri] = useState<string | null>(null)
  const [sourceFileName, setSourceFileName] = useState<string | null>(null)
  const [aspectRatio, setAspectRatio] = useState<string | null>(savedForm.aspectRatio)
  const [profile, setProfile] = useState<string | null>(savedForm.profile)
  const [extraValues, setExtraValues] = useState<Record<string, number>>(savedForm.extraValues)
  const [submitting, setSubmitting] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [viewingEntry, setViewingEntry] = useState<HistoryEntry | null>(null)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCountRef = useRef(0)
  const savedJobRef = useRef<Set<string>>(new Set())

  const capability = capabilityId
    ? CAPABILITIES.find((c) => c.id === capabilityId) ?? null
    : null

  const filteredCapabilities = CAPABILITIES.filter((c) => c.category === category)

  const sourceType = sourceUri
    ? /^data:image\//i.test(sourceUri) ? "image" : /^data:video\//i.test(sourceUri) ? "video" : /^data:audio\//i.test(sourceUri) ? "audio" : "other"
    : null
  const sourceCompatible = capability?.needsSource
    ? capability.sourceAccept?.startsWith(sourceType ?? "") ?? false
    : false

  // Convex subscription for active job
  const job = useQuery(
    api.media_jobs.getByJobId,
    activeJobId ? { jobId: activeJobId } : "skip",
  ) as Record<string, unknown> | null | undefined

  const jobStatus = (job?.status ?? null) as string | null
  const jobOutput = job?.output
  const jobError = job?.error as { message?: string } | undefined

  // When job completes, save to history + desktop/state
  useEffect(() => {
    if (!activeJobId) return
    if (savedJobRef.current.has(activeJobId)) return

    if (jobStatus === "succeeded" && jobOutput) {
      savedJobRef.current.add(activeJobId)
      const output = extractOutput(jobOutput)
      const updated = updateHistoryEntry(activeJobId, { status: "succeeded", output })
      setHistory(updated)
      const jobIdCopy = activeJobId
      let cancelled = false

      // Save files to desktop/state
      void saveOutputToStella(output, jobIdCopy).then((saved) => {
        if (!cancelled && saved !== output) {
          setHistory(updateHistoryEntry(jobIdCopy, { output: saved }))
        }
      })

      // Generate thumbnail for the strip
      if (output.kind === "image" && output.urls[0]) {
        void generateThumb(output.urls[0]).then((thumb) => {
          if (!cancelled && thumb) {
            setHistory(updateHistoryEntry(jobIdCopy, { thumb }))
          }
        })
      }

      return () => { cancelled = true }
    }

    if (jobStatus === "failed") {
      savedJobRef.current.add(activeJobId)
      setHistory(updateHistoryEntry(activeJobId, {
        status: "failed",
        error: jobError?.message ?? "Generation failed",
      }))
    }
  }, [activeJobId, jobStatus, jobOutput, jobError])

  // Persist form state on changes
  const persistForm = useCallback((patch: Partial<FormState>) => {
    saveFormState({ ...loadFormState(), ...patch })
  }, [])

  /* ── Handlers ── */

  const handleCategoryChange = useCallback((cat: Category) => {
    startTransition(() => {
      setCategory(cat)
      setCapabilityId(null)
      setAspectRatio(null)
      setProfile(null)
      setExtraValues({})
      setError(null)
      setActiveJobId(null)
      setViewingEntry(null)
      persistForm({ category: cat, capabilityId: null, aspectRatio: null, profile: null, extraValues: {} })
    })
  }, [persistForm])

  const handleCapabilitySelect = useCallback((id: string) => {
    const cap = CAPABILITIES.find((c) => c.id === id)
    const newProfile = cap?.profiles?.[0]?.id ?? null
    const newExtra = Object.fromEntries(
      (cap?.extraFields ?? []).map((f) => [f.key, f.default]),
    )
    startTransition(() => {
      setCapabilityId(id)
      setPrompt("")
      setAspectRatio(null)
      setError(null)
      setActiveJobId(null)
      setViewingEntry(null)
      setProfile(newProfile)
      setExtraValues(newExtra)
      persistForm({ capabilityId: id, prompt: "", aspectRatio: null, profile: newProfile, extraValues: newExtra })
    })
  }, [persistForm])

  const handlePromptChange = useCallback((value: string) => {
    setPrompt(value)
    persistForm({ prompt: value })
  }, [persistForm])

  const handleAspectRatioToggle = useCallback((ar: string) => {
    const next = aspectRatio === ar ? null : ar
    setAspectRatio(next)
    persistForm({ aspectRatio: next })
  }, [aspectRatio, persistForm])

  const handleProfileChange = useCallback((id: string) => {
    setProfile(id)
    persistForm({ profile: id })
  }, [persistForm])

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
    setViewingEntry(null)

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

      const entry: HistoryEntry = {
        id: result.jobId,
        capability: capability.id,
        capabilityName: capability.name,
        prompt: prompt.trim() || undefined,
        timestamp: Date.now(),
        output: null,
        status: "pending",
      }

      // Tell the global materializer to skip this job — MediaStudio will
      // present the result inline. Without this the workspace panel would
      // pop open over the studio when the job completes. We mark up-front
      // (not on success) to avoid a race where the materializer's
      // subscription fires first.
      markMediaJobMaterialized(result.jobId)

      startTransition(() => {
        setActiveJobId(result.jobId)
        setHistory(addHistoryEntry(entry))
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed")
    } finally {
      setSubmitting(false)
    }
  }, [capability, prompt, sourceUri, aspectRatio, profile, extraValues])

  const handleHistoryClick = useCallback((entry: HistoryEntry) => {
    setViewingEntry(entry)
    setActiveJobId(null)
  }, [])

  const handleCopyImage = useCallback(async (url: string) => {
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const pngBlob = blob.type === "image/png"
        ? blob
        : await new Promise<Blob>((resolve) => {
            const img = new Image()
            img.crossOrigin = "anonymous"
            img.onload = () => {
              const canvas = document.createElement("canvas")
              canvas.width = img.naturalWidth
              canvas.height = img.naturalHeight
              canvas.getContext("2d")!.drawImage(img, 0, 0)
              canvas.toBlob((b) => resolve(b!), "image/png")
            }
            img.src = url
          })
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })])
    } catch {
      // silent fail
    }
  }, [])

  /** Load an output URL as the source and switch to a target capability. */
  const handleSendTo = useCallback((targetCapId: string, url: string) => {
    const cap = CAPABILITIES.find((c) => c.id === targetCapId)
    if (!cap) return
    const targetCat = cap.category as Category

    // Infer a file name from the URL
    const urlName = url.split("/").pop()?.split("?")[0] ?? "output"

    startTransition(() => {
      setCategory(targetCat)
      setCapabilityId(targetCapId)
      setSourceUri(url)
      setSourceFileName(urlName)
      setPrompt("")
      setAspectRatio(null)
      setError(null)
      setActiveJobId(null)
      setViewingEntry(null)
      setProfile(cap.profiles?.[0]?.id ?? null)
      setExtraValues(
        Object.fromEntries((cap.extraFields ?? []).map((f) => [f.key, f.default])),
      )
      persistForm({
        category: targetCat,
        capabilityId: targetCapId,
        prompt: "",
        aspectRatio: null,
        profile: cap.profiles?.[0]?.id ?? null,
        extraValues: Object.fromEntries((cap.extraFields ?? []).map((f) => [f.key, f.default])),
      })
    })
  }, [persistForm])

  const canSubmit =
    capability &&
    !submitting &&
    (!capability.needsPrompt || prompt.trim().length > 0) &&
    (!capability.needsSource || (sourceUri !== null && sourceCompatible))

  // Determine what to show in the output panel
  const liveOutput = useMemo(
    () => (activeJobId && jobStatus === "succeeded" && jobOutput ? extractOutput(jobOutput) : null),
    [activeJobId, jobStatus, jobOutput],
  )
  const activeOutput: OutputMedia | null = viewingEntry?.output ?? liveOutput

  const showPending = activeJobId && !viewingEntry && (jobStatus === "queued" || jobStatus === "running")
  const showFailed = (activeJobId && !viewingEntry && jobStatus === "failed") ||
    (viewingEntry?.status === "failed")
  const showOutput = activeOutput && activeOutput.kind !== "unknown"
  const failMessage = viewingEntry?.error ?? jobError?.message ?? "Generation failed"

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
                          onClick={() => handleProfileChange(p.id)}
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
                      onChange={(e) => handlePromptChange(e.target.value)}
                      placeholder="Describe what you'd like…"
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
                          onClick={() => handleAspectRatioToggle(ar)}
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
                        setExtraValues((prev) => {
                          const next = { ...prev, [field.key]: val }
                          persistForm({ extraValues: next })
                          return next
                        })
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

      {/* ── Right: output + history strip ── */}
      <div className="ms-right">
        <div className="ms-output-panel">
          {dragging && (
            <div className="ms-drop-overlay">
              <div className="ms-drop-label">Drop file</div>
            </div>
          )}

          {!showPending && !showFailed && !showOutput && !dragging && (
            <div className="ms-empty">
              <div className="ms-empty-title">Your creation</div>
              <div className="ms-empty-desc">
                Pick a capability and generate — or drop a file anywhere to get started.
              </div>
            </div>
          )}

          {showPending && (
            <div className="ms-status">
              <span className="ms-status-dot" />
              <span className="ms-status-text">
                {jobStatus === "queued" ? "Waiting in queue…" : "Generating…"}
              </span>
            </div>
          )}

          {showFailed && (
            <p className="ms-error">{failMessage}</p>
          )}

          {showOutput && activeOutput && (
            <div className="ms-output">
              {activeOutput.kind === "image" && (
                <>
                  <div className="ms-output-images">
                    {activeOutput.urls.map((url, i) => (
                      <button
                        key={url}
                        type="button"
                        className="ms-output-image-btn"
                        onClick={() => setLightboxUrl(url)}
                      >
                        <img src={url} alt={`Generated ${i + 1}`} className="ms-output-image" />
                      </button>
                    ))}
                  </div>
                  <div className="ms-actions">
                    <button type="button" className="ms-action" onClick={() => void handleCopyImage(activeOutput.urls[0])}>
                      Copy
                    </button>
                    <button type="button" className="ms-action" onClick={() => handleSendTo("image_edit", activeOutput.urls[0])}>
                      Edit
                    </button>
                    <button type="button" className="ms-action" onClick={() => handleSendTo("image_to_video", activeOutput.urls[0])}>
                      Animate
                    </button>
                  </div>
                </>
              )}
              {activeOutput.kind === "video" && (
                <>
                  <video src={activeOutput.url} controls className="ms-output-video" />
                  <div className="ms-actions">
                    <button type="button" className="ms-action" onClick={() => handleSendTo("video_to_video", activeOutput.url)}>
                      Transform video
                    </button>
                    <button type="button" className="ms-action" onClick={() => handleSendTo("video_extend", activeOutput.url)}>
                      Extend video
                    </button>
                  </div>
                </>
              )}
              {activeOutput.kind === "audio" && (
                <audio src={activeOutput.url} controls className="ms-output-audio" />
              )}
              {activeOutput.kind === "text" && (
                <div className="ms-output-text"><p>{activeOutput.text}</p></div>
              )}
              {activeOutput.kind === "download" && (
                <a href={activeOutput.url} target="_blank" rel="noreferrer" className="ms-output-download">
                  {activeOutput.label}
                </a>
              )}
            </div>
          )}
        </div>

        {/* History strip */}
        {history.length > 0 && (
          <div className="ms-strip">
            <div className="ms-strip-scroll">
              {history.map((entry) => {
                const isActive = viewingEntry?.id === entry.id || activeJobId === entry.id
                const thumbSrc = entry.thumb ?? null

                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={`ms-strip-item ${isActive ? "ms-strip-item--active" : ""}`}
                    onClick={() => handleHistoryClick(entry)}
                    title={entry.prompt ?? entry.capabilityName}
                  >
                    {thumbSrc ? (
                      <img src={thumbSrc} alt="" className="ms-strip-thumb" />
                    ) : (
                      <div className={`ms-strip-placeholder ms-strip-placeholder--${entry.output?.kind ?? "pending"}`}>
                        {entry.status === "pending" && <span className="ms-strip-dot" />}
                        {entry.status === "failed" && "✕"}
                        {entry.status === "succeeded" && entry.output?.kind === "video" && "▶"}
                        {entry.status === "succeeded" && entry.output?.kind === "audio" && "♪"}
                        {entry.status === "succeeded" && entry.output?.kind === "text" && "Aa"}
                        {entry.status === "succeeded" && entry.output?.kind === "download" && "↓"}
                        {entry.status === "succeeded" && entry.output?.kind === "unknown" && "?"}
                      </div>
                    )}
                    <span className="ms-strip-label">{entry.capabilityName}</span>
                  </button>
                )
              })}
              <button
                type="button"
                className="ms-strip-folder"
                onClick={() => void openOutputsFolder()}
                title="Open outputs folder"
              >
                <FolderIcon />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxUrl && (
        <div className="ms-lightbox" onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="" className="ms-lightbox-img" onClick={(e) => e.stopPropagation()} />
          <button type="button" className="ms-lightbox-close" onClick={() => setLightboxUrl(null)}>✕</button>
        </div>
      )}
    </div>
  )
}
