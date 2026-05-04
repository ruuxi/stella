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
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
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
  { value: "public", title: "Public", sub: "Listed on the Store" },
  { value: "unlisted", title: "Unlisted", sub: "Anyone with the link" },
  { value: "private", title: "Private", sub: "Only you" },
];

const PACK_ID_BASE_PATTERN = /[^a-z0-9]+/g;

const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(PACK_ID_BASE_PATTERN, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const buildPackId = (): string => {
  const slug = slugify("emoji pack") || "pack";
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
  const [prompt, setPrompt] = useState("");
  const [visibility, setVisibility] = useState<EmojiPackVisibility>("private");
  const [submitting, setSubmitting] = useState(false);

  const objectUrlsRef = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
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
    setPrompt("");
    setVisibility("private");
    setSubmitting(false);
  }, []);

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
  const anyBusy = sheet1.busy || sheet2.busy;

  // Which sheets need a fresh job — exactly one when the previous run
  // half-succeeded, both otherwise.
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
    if (anyBusy) return;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      showToast({
        title: "Tell Stella the vibe first",
        variant: "error",
      });
      return;
    }
    processedJobsRef.current = new Set();
    const targets =
      failedOnlySheets.length > 0
        ? failedOnlySheets
        : ([...EMOJI_SHEET_INDICES] as EmojiSheetIndex[]);
    const updaters: Record<EmojiSheetIndex, (next: SheetState) => void> = {
      0: setSheet1,
      1: setSheet2,
    };
    if (failedOnlySheets.length === 0) {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current = [];
    }
    for (const idx of targets) {
      updaters[idx]({ jobId: null, blob: null, busy: true, error: null });
    }
    try {
      const submissions = await Promise.all(
        targets.map((i) => submitEmojiSheetJob(i, trimmedPrompt)),
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
  }, [anyBusy, failedOnlySheets, prompt]);

  const handlePublish = useCallback(async () => {
    if (!bothBlobs) return;
    const cover = glyphForCell(coverSheet, coverCell);
    if (!cover) {
      showToast({ title: "Pick a cover emoji", variant: "error" });
      return;
    }
    setSubmitting(true);
    try {
      const packId = buildPackId();
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
        // Backend enrichment overwrites this immediately with a friendly
        // generated name + description + tags.
        displayName: "Stella emoji pack",
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
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
      showToast({ title: "Pack ready", variant: "success" });
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
    onOpenChange,
    prompt,
    resetTransient,
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

  const generateLabel = anyBusy
    ? "Generating…"
    : failedOnlySheets.length > 0
    ? failedOnlySheets.length === 1
      ? "Retry sheet"
      : "Retry sheets"
    : sheet1.blob && sheet2.blob
    ? "Regenerate"
    : "Generate";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="emoji-create-dialog">
        <DialogCloseButton disabled={submitting} />
        <DialogHeader>
          <DialogTitle className="emoji-create-title">
            Create emoji pack
          </DialogTitle>
          <p className="emoji-create-caption">
            Describe the vibe — Stella paints 128 custom emojis across two
            sheets and names the pack for you.
          </p>
        </DialogHeader>
        <DialogBody className="emoji-create-body">
          <section
            className="emoji-create-stage"
            aria-label="Generated emoji preview"
          >
            {activeBlob ? (
              <>
                <div className="emoji-create-stage-tabs">
                  <button
                    type="button"
                    className="emoji-create-arrow"
                    aria-label="Previous sheet"
                    disabled={previewSheet === 0}
                    onClick={() =>
                      setPreviewSheet((current) =>
                        Math.max(0, current - 1) as EmojiSheetIndex,
                      )
                    }
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span className="emoji-create-stage-label">
                    Sheet {previewSheet + 1} of {EMOJI_SHEET_INDICES.length}
                  </span>
                  <button
                    type="button"
                    className="emoji-create-arrow"
                    aria-label="Next sheet"
                    disabled={previewSheet === EMOJI_SHEET_INDICES.length - 1}
                    onClick={() =>
                      setPreviewSheet((current) =>
                        Math.min(
                          EMOJI_SHEET_INDICES.length - 1,
                          current + 1,
                        ) as EmojiSheetIndex,
                      )
                    }
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
                <div
                  className="emoji-create-grid"
                  role="grid"
                  aria-label="Pick a cover"
                >
                  {Array.from({ length: EMOJI_SHEET_CELL_COUNT }).map(
                    (_, cellIdx) => {
                      const isCover =
                        coverSheet === previewSheet && coverCell === cellIdx;
                      const glyph =
                        EMOJI_SHEETS[previewSheet]?.[cellIdx] ?? "";
                      return (
                        <button
                          key={cellIdx}
                          type="button"
                          className="emoji-create-cell"
                          data-cover={isCover || undefined}
                          onClick={() => {
                            setCoverSheet(previewSheet);
                            setCoverCell(cellIdx);
                          }}
                          aria-label={`Use ${
                            glyph || `cell ${cellIdx + 1}`
                          } as cover`}
                          title={glyph}
                        >
                          <EmojiCellPreview
                            sheetUrl={activeBlob.objectUrl}
                            cell={cellIdx}
                            size={32}
                          />
                        </button>
                      );
                    },
                  )}
                </div>
                <p className="emoji-create-hint">
                  Tap any emoji to set it as the pack cover
                  {glyphForCell(coverSheet, coverCell)
                    ? ` · current cover ${glyphForCell(coverSheet, coverCell)}`
                    : ""}
                  .
                </p>
              </>
            ) : (
              <div
                className="emoji-create-empty"
                data-state={
                  activeBusy ? "busy" : activeError ? "error" : "empty"
                }
              >
                <Sparkles size={22} aria-hidden />
                <span className="emoji-create-empty-text">
                  {activeBusy
                    ? "Painting your pack…"
                    : activeError
                    ? activeError
                    : "Stella's emojis appear here"}
                </span>
              </div>
            )}
          </section>

          <form
            className="emoji-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!bothBlobs) {
                void handleStartGeneration();
                return;
              }
              void handlePublish();
            }}
          >
            <label className="emoji-create-field">
              <span className="emoji-create-field-label">
                How should the pack feel?
              </span>
              <textarea
                className="emoji-create-textarea"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe the vibe — neon synthwave, soft pastel, claymation, …"
                rows={3}
                maxLength={2000}
                autoFocus
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
                size="normal"
                className="pill-btn pill-btn--lg"
                onClick={() => void handleStartGeneration()}
                disabled={
                  anyBusy || submitting || prompt.trim().length === 0
                }
              >
                <Sparkles size={14} />
                {generateLabel}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="normal"
                className="pill-btn pill-btn--primary pill-btn--lg"
                disabled={!bothBlobs || submitting}
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
