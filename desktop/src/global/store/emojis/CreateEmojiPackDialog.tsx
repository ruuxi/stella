import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "convex/react";
import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import { api } from "@/convex/api";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import { showToast } from "@/ui/toast";
import {
  EMOJI_SHEETS,
  EMOJI_SHEET_CELL_COUNT,
} from "@/app/chat/emoji-sprites/cells";
import { writeActiveEmojiPack } from "@/app/chat/emoji-sprites/active-emoji-pack";
import {
  EMOJI_SHEET_INDICES,
  type EmojiSheetIndex,
  type EmojiSheetBlob,
  buildEmojiCoverBlob,
  extractFirstImageUrl,
  processSheetImage,
  submitEmojiSheetJob,
  uploadSheetToR2,
} from "./emoji-pack-generation";
import { EmojiCellPreview } from "./EmojiCellPreview";
import { glyphForCell } from "./emoji-pack-cells";
import {
  useCreateEmojiPackUploadUrls,
  useEmojiPackMutations,
  type EmojiPackVisibility,
} from "./emoji-pack-data";

type CreateEmojiPackDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type SheetState = {
  jobId: string | null;
  blob: EmojiSheetBlob | null;
  /** "Working on it" while we either wait on the model or run the
   *  client-side magenta keying. */
  busy: boolean;
  error: string | null;
};

const EMPTY_SHEET: SheetState = {
  jobId: null,
  blob: null,
  busy: false,
  error: null,
};

const VISIBILITY_OPTIONS: ReadonlyArray<{
  value: EmojiPackVisibility;
  title: string;
  sub: string;
}> = [
  {
    value: "public",
    title: "Public",
    sub: "Listed on the Store",
  },
  {
    value: "unlisted",
    title: "Unlisted",
    sub: "Anyone with the link",
  },
  {
    value: "private",
    title: "Private",
    sub: "Only you",
  },
];

const DEFAULT_STYLE = "playful party style";

const PACK_ID_BASE_PATTERN = /[^a-z0-9]+/g;

/** Hand-rolled slug for the visible name → fallback `packId`. The
 *  backend re-validates with `PACK_ID_PATTERN` so slop here just shows
 *  up as a clean error rather than a corrupt row. */
const slugify = (value: string): string => {
  const base = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(PACK_ID_BASE_PATTERN, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base;
};

/** Append a 6-char timestamp suffix so two packs created back-to-back
 *  with the same display name don't collide on `packId`. */
const buildPackId = (displayName: string): string => {
  const slug = slugify(displayName) || "pack";
  const suffix = Date.now().toString(36).slice(-6);
  return `${slug}-${suffix}`;
};

const isMediaJobSnapshot = (
  value: unknown,
): value is { status?: string; output?: unknown; error?: { message?: string } } =>
  Boolean(value) && typeof value === "object";

export function CreateEmojiPackDialog({
  open,
  onOpenChange,
}: CreateEmojiPackDialogProps) {
  const { createPack } = useEmojiPackMutations();
  const createUploadUrls = useCreateEmojiPackUploadUrls();

  const [sheet1, setSheet1] = useState<SheetState>({ ...EMPTY_SHEET });
  const [sheet2, setSheet2] = useState<SheetState>({ ...EMPTY_SHEET });
  const [previewSheet, setPreviewSheet] = useState<EmojiSheetIndex>(0);
  const [coverSheet, setCoverSheet] = useState<EmojiSheetIndex>(0);
  const [coverCell, setCoverCell] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<EmojiPackVisibility>("private");
  const [submitting, setSubmitting] = useState(false);

  // Hold object URLs in a ref so the cleanup pass can revoke them
  // even when the component unmounts mid-flight.
  const objectUrlsRef = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const url of objectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      objectUrlsRef.current = [];
    },
    [],
  );

  const resetTransient = useCallback(() => {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    objectUrlsRef.current = [];
    setSheet1({ ...EMPTY_SHEET });
    setSheet2({ ...EMPTY_SHEET });
    setPreviewSheet(0);
    setCoverSheet(0);
    setCoverCell(0);
    setDisplayName("");
    setStyle(DEFAULT_STYLE);
    setDescription("");
    setVisibility("private");
    setSubmitting(false);
  }, [setSheet1, setSheet2]);

  // Convex `media_jobs.getByJobId` subscriptions — one per sheet. We
  // skip the query until a job exists. Once the job lands as
  // `succeeded`, an effect downstream pulls the URL, runs the keying,
  // and stashes the resulting blob.
  const job1 = useQuery(
    api.media_jobs.getByJobId,
    sheet1.jobId ? { jobId: sheet1.jobId } : "skip",
  );
  const job2 = useQuery(
    api.media_jobs.getByJobId,
    sheet2.jobId ? { jobId: sheet2.jobId } : "skip",
  );

  const processedJobsRef = useRef<Set<string>>(new Set());

  const consumeJob = useCallback(
    async (
      job: unknown,
      setSheet: (next: SheetState) => void,
      currentJobId: string | null,
    ) => {
      if (!currentJobId || !isMediaJobSnapshot(job) || job.status !== "succeeded") {
        return;
      }
      if (processedJobsRef.current.has(currentJobId)) return;
      processedJobsRef.current.add(currentJobId);
      const url = extractFirstImageUrl(job.output);
      if (!url) {
        setSheet({
          jobId: currentJobId,
          blob: null,
          busy: false,
          error: "Generation finished without an image",
        });
        return;
      }
      try {
        const processed = await processSheetImage(url);
        objectUrlsRef.current.push(processed.objectUrl);
        setSheet({
          jobId: currentJobId,
          blob: processed,
          busy: false,
          error: null,
        });
      } catch (err) {
        setSheet({
          jobId: currentJobId,
          blob: null,
          busy: false,
          error: err instanceof Error ? err.message : "Couldn't process sheet",
        });
      }
    },
    [],
  );

  useEffect(() => {
    void consumeJob(job1, setSheet1, sheet1.jobId);
  }, [job1, sheet1.jobId, consumeJob]);
  useEffect(() => {
    void consumeJob(job2, setSheet2, sheet2.jobId);
  }, [job2, sheet2.jobId, consumeJob]);

  // Surface model-side failures so the UX matches a "couldn't
  // generate" state rather than spinning forever.
  useEffect(() => {
    if (
      sheet1.jobId &&
      isMediaJobSnapshot(job1) &&
      (job1.status === "failed" || job1.status === "canceled") &&
      !sheet1.error
    ) {
      const message = job1.error?.message ?? "Generation failed";
      setSheet1((current) => ({ ...current, busy: false, error: message }));
    }
  }, [job1, sheet1.jobId, sheet1.error]);
  useEffect(() => {
    if (
      sheet2.jobId &&
      isMediaJobSnapshot(job2) &&
      (job2.status === "failed" || job2.status === "canceled") &&
      !sheet2.error
    ) {
      const message = job2.error?.message ?? "Generation failed";
      setSheet2((current) => ({ ...current, busy: false, error: message }));
    }
  }, [job2, sheet2.jobId, sheet2.error]);

  const bothBlobs = useMemo(
    () => (sheet1.blob && sheet2.blob ? [sheet1.blob, sheet2.blob] : null),
    [sheet1.blob, sheet2.blob],
  );

  const sheets = [sheet1, sheet2];
  const activeSheet = sheets[previewSheet];
  const activeBlob = activeSheet?.blob ?? null;
  const activeError = activeSheet?.error ?? null;
  const activeBusy = activeSheet?.busy ?? false;

  // Which sheets need a fresh job — exactly one when the previous run
  // half-succeeded, both otherwise. We retry only the failed slot so a
  // good sheet doesn't get tossed.
  const failedOnlySheets = useMemo<EmojiSheetIndex[]>(() => {
    const sheetsState: Array<{ blob: SheetState["blob"]; error: string | null }> = [
      sheet1,
      sheet2,
    ];
    const failed: EmojiSheetIndex[] = [];
    let hasSuccess = false;
    sheetsState.forEach((s, idx) => {
      if (s.blob) hasSuccess = true;
      else if (s.error) failed.push(idx as EmojiSheetIndex);
    });
    return hasSuccess && failed.length > 0 ? failed : [];
  }, [sheet1, sheet2]);

  const handleStartGeneration = useCallback(async () => {
    if (sheet1.busy || sheet2.busy) return;
    processedJobsRef.current = new Set();
    const targets =
      failedOnlySheets.length > 0
        ? failedOnlySheets
        : ([...EMOJI_SHEET_INDICES] as EmojiSheetIndex[]);
    const updaters: Record<EmojiSheetIndex, (next: SheetState) => void> = {
      0: setSheet1,
      1: setSheet2,
    };
    // Only clear the slots we're about to retry — the keeper sheet
    // (success on the previous run) stays mounted with its preview.
    if (failedOnlySheets.length === 0) {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current = [];
    }
    for (const idx of targets) {
      updaters[idx]({ jobId: null, blob: null, busy: true, error: null });
    }
    try {
      const submissions = await Promise.all(
        targets.map((i) => submitEmojiSheetJob(i, style)),
      );
      submissions.forEach((submission, position) => {
        const idx = targets[position]!;
        updaters[idx]({
          jobId: submission.jobId,
          blob: null,
          busy: true,
          error: null,
        });
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Couldn't start generation";
      for (const idx of targets) {
        updaters[idx]({ jobId: null, blob: null, busy: false, error: message });
      }
      showToast({ title: message, variant: "error" });
    }
  }, [
    failedOnlySheets,
    sheet1.busy,
    sheet2.busy,
    setSheet1,
    setSheet2,
    style,
  ]);

  const handlePublish = useCallback(async () => {
    if (!bothBlobs) return;
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      showToast({ title: "Give your pack a name", variant: "error" });
      return;
    }
    const packId = buildPackId(trimmedName);
    const cover = glyphForCell(coverSheet, coverCell);
    if (!cover) {
      showToast({ title: "Pick a cover emoji", variant: "error" });
      return;
    }
    setSubmitting(true);
    try {
      const coverSourceBlob = bothBlobs[coverSheet]!;
      const coverBlob = await buildEmojiCoverBlob(
        coverSourceBlob.blob,
        coverCell,
      );
      objectUrlsRef.current.push(coverBlob.objectUrl);
      const upload = await createUploadUrls({
        packId,
        sheet1Sha256: bothBlobs[0]!.sha256,
        sheet2Sha256: bothBlobs[1]!.sha256,
        coverSha256: coverBlob.sha256,
        contentType: "image/webp",
      });
      const uploads: Array<Promise<void>> = [
        uploadSheetToR2(bothBlobs[0]!.blob, upload.sheet1),
        uploadSheetToR2(bothBlobs[1]!.blob, upload.sheet2),
      ];
      if (upload.cover) {
        uploads.push(uploadSheetToR2(coverBlob.blob, upload.cover));
      }
      await Promise.all(uploads);
      const created = await createPack({
        packId,
        displayName: trimmedName,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(style.trim() && style.trim() !== DEFAULT_STYLE
          ? { prompt: style.trim() }
          : {}),
        coverEmoji: cover,
        ...(upload.cover ? { coverUrl: upload.cover.publicUrl } : {}),
        sheet1Url: upload.sheet1.publicUrl,
        sheet2Url: upload.sheet2.publicUrl,
        visibility,
      });
      writeActiveEmojiPack({
        packId: created.packId,
        sheet1Url: created.sheet1Url,
        sheet2Url: created.sheet2Url,
      });
      showToast({ title: `“${trimmedName}” is ready`, variant: "success" });
      onOpenChange(false);
      resetTransient();
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : "Couldn't publish pack",
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    bothBlobs,
    coverCell,
    coverSheet,
    createPack,
    createUploadUrls,
    description,
    displayName,
    onOpenChange,
    resetTransient,
    style,
    visibility,
  ]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (submitting) return;
      onOpenChange(next);
      if (!next) resetTransient();
    },
    [onOpenChange, resetTransient, submitting],
  );

  const cellsForActiveSheet = EMOJI_SHEETS[previewSheet] ?? [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="xl" className="emoji-create-dialog">
        <DialogCloseButton disabled={submitting} />
        <DialogTitle>Create emoji pack</DialogTitle>
        <DialogDescription>
          Describe a vibe. Stella generates 128 custom emojis split across two
          sheets. Pick a cover, name it, and you're ready to use it in chat.
        </DialogDescription>
        <DialogBody className="emoji-create-body">
          <div className="emoji-create-preview">
            <div className="emoji-create-preview-tabs">
              <button
                type="button"
                className="emoji-create-arrow"
                aria-label="Previous sheet"
                disabled={previewSheet === 0}
                onClick={() =>
                  setPreviewSheet((current) =>
                    (Math.max(0, current - 1) as EmojiSheetIndex),
                  )
                }
              >
                <ChevronLeft size={16} />
              </button>
              <span className="emoji-create-preview-label">
                Sheet {previewSheet + 1} of {EMOJI_SHEET_INDICES.length}
              </span>
              <button
                type="button"
                className="emoji-create-arrow"
                aria-label="Next sheet"
                disabled={previewSheet === EMOJI_SHEET_INDICES.length - 1}
                onClick={() =>
                  setPreviewSheet((current) =>
                    (Math.min(
                      EMOJI_SHEET_INDICES.length - 1,
                      current + 1,
                    ) as EmojiSheetIndex),
                  )
                }
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="emoji-create-grid" data-state={
              activeBlob ? "ready" : activeBusy ? "busy" : activeError ? "error" : "empty"
            }>
              {Array.from({ length: EMOJI_SHEET_CELL_COUNT }).map((_, cellIdx) => {
                const isCover =
                  coverSheet === previewSheet && coverCell === cellIdx;
                const glyph = cellsForActiveSheet[cellIdx] ?? "";
                return (
                  <button
                    key={cellIdx}
                    type="button"
                    className="emoji-create-cell"
                    data-cover={isCover || undefined}
                    disabled={!activeBlob}
                    onClick={() => {
                      setCoverSheet(previewSheet);
                      setCoverCell(cellIdx);
                    }}
                    aria-label={`Use ${glyph || `cell ${cellIdx + 1}`} as cover`}
                    title={glyph}
                  >
                    {activeBlob ? (
                      <EmojiCellPreview
                        sheetUrl={activeBlob.objectUrl}
                        cell={cellIdx}
                        size={36}
                      />
                    ) : (
                      <span className="emoji-create-cell-placeholder">{glyph}</span>
                    )}
                  </button>
                );
              })}
            </div>
            {activeError ? (
              <div className="emoji-create-state-line emoji-create-state-line--error">
                {activeError}
              </div>
            ) : activeBusy ? (
              <div className="emoji-create-state-line">
                Generating sheet {previewSheet + 1}…
              </div>
            ) : !activeBlob ? (
              <div className="emoji-create-state-line">
                Click <strong>Generate</strong> to create this sheet.
              </div>
            ) : (
              <div className="emoji-create-state-line">
                Pick any emoji as the cover. Cover currently:{" "}
                <strong>
                  {glyphForCell(coverSheet, coverCell) || "—"}
                </strong>
              </div>
            )}
          </div>

          <form
            className="emoji-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handlePublish();
            }}
          >
            <TextField
              label="Pack name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="e.g. Synthwave"
              maxLength={80}
              autoFocus
            />
            <label className="emoji-create-field">
              <span className="emoji-create-field-label">Style prompt</span>
              <textarea
                className="emoji-create-textarea"
                value={style}
                onChange={(event) => setStyle(event.target.value)}
                placeholder="Describe the look — “neon synthwave”, “watercolor”, “pixel art”, …"
                rows={2}
                maxLength={2000}
              />
            </label>
            <label className="emoji-create-field">
              <span className="emoji-create-field-label">
                Description <span className="emoji-create-field-hint">optional</span>
              </span>
              <textarea
                className="emoji-create-textarea"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="One line others see in the Store"
                rows={2}
                maxLength={500}
              />
            </label>
            <div className="emoji-create-field">
              <span className="emoji-create-field-label">Visibility</span>
              <div className="emoji-create-visibility">
                {VISIBILITY_OPTIONS.map((option) => (
                  <button
                    type="button"
                    key={option.value}
                    className="emoji-create-visibility-pill"
                    data-active={visibility === option.value || undefined}
                    onClick={() => setVisibility(option.value)}
                  >
                    <span className="emoji-create-visibility-title">
                      {option.title}
                    </span>
                    <span className="emoji-create-visibility-sub">
                      {option.sub}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="emoji-create-actions">
              <Button
                type="button"
                variant="secondary"
                size="large"
                className="pill-btn pill-btn--lg"
                onClick={() => void handleStartGeneration()}
                disabled={sheet1.busy || sheet2.busy || submitting}
              >
                <Sparkles size={14} />
                {sheet1.busy || sheet2.busy
                  ? "Generating…"
                  : failedOnlySheets.length > 0
                  ? failedOnlySheets.length === 1
                    ? "Retry failed sheet"
                    : "Retry failed sheets"
                  : sheet1.blob && sheet2.blob
                  ? "Regenerate"
                  : "Generate"}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="large"
                className="pill-btn pill-btn--primary pill-btn--lg"
                disabled={
                  !bothBlobs || !displayName.trim() || submitting
                }
              >
                {submitting ? "Saving…" : "Save pack"}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

