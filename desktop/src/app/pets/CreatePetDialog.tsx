import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { Sparkles } from "lucide-react";
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
import { PetSprite } from "@/shell/pet/PetSprite";
import type { PetAnimationState } from "@/shared/contracts/pet";
import { writeSelectedPetId } from "@/shell/pet/pet-preferences";
import {
  useCreateUserPetUploadUrl,
  useUserPetMutations,
  type UserPetVisibility,
} from "./user-pet-data";
import {
  extractFirstImageUrl,
  processUserPetAtlasImage,
  submitUserPetAtlasJob,
  uploadUserPetSpritesheetToR2,
  type UserPetSpritesheetBlob,
} from "./user-pet-generation";

type CreatePetDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type GenerationState = {
  jobId: string | null;
  blob: UserPetSpritesheetBlob | null;
  busy: boolean;
  error: string | null;
};

const EMPTY: GenerationState = {
  jobId: null,
  blob: null,
  busy: false,
  error: null,
};

const VISIBILITY_OPTIONS: ReadonlyArray<{
  value: UserPetVisibility;
  title: string;
  sub: string;
}> = [
  { value: "public", title: "Public", sub: "Listed on the Store" },
  { value: "unlisted", title: "Unlisted", sub: "Anyone with the link" },
  { value: "private", title: "Private", sub: "Only you" },
];

const PREVIEW_STATES: PetAnimationState[] = [
  "idle",
  "running-right",
  "waving",
  "jumping",
];

const PET_ID_BASE_PATTERN = /[^a-z0-9]+/g;

const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(PET_ID_BASE_PATTERN, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const buildPetId = (displayName: string): string => {
  const slug = slugify(displayName) || "pet";
  const suffix = Date.now().toString(36).slice(-6);
  return `${slug}-${suffix}`;
};

const isMediaJobSnapshot = (
  value: unknown,
): value is { status?: string; output?: unknown; error?: { message?: string } } =>
  Boolean(value) && typeof value === "object";

export function CreatePetDialog({ open, onOpenChange }: CreatePetDialogProps) {
  const { createPet } = useUserPetMutations();
  const createUploadUrl = useCreateUserPetUploadUrl();

  const [state, setState] = useState<GenerationState>({ ...EMPTY });
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [style, setStyle] = useState("");
  const [visibility, setVisibility] = useState<UserPetVisibility>("private");
  const [submitting, setSubmitting] = useState(false);
  const [previewState, setPreviewState] =
    useState<PetAnimationState>("idle");

  const objectUrlRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    },
    [],
  );

  const resetTransient = useCallback(() => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
    setState({ ...EMPTY });
    setDisplayName("");
    setDescription("");
    setStyle("");
    setVisibility("private");
    setSubmitting(false);
    setPreviewState("idle");
  }, []);

  const job = useQuery(
    api.media_jobs.getByJobId,
    state.jobId ? { jobId: state.jobId } : "skip",
  );

  const processedJobsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentJobId = state.jobId;
    if (!currentJobId || !isMediaJobSnapshot(job)) return;
    if (job.status === "succeeded") {
      if (processedJobsRef.current.has(currentJobId)) return;
      processedJobsRef.current.add(currentJobId);
      const url = extractFirstImageUrl(job.output);
      if (!url) {
        setState({
          jobId: currentJobId,
          blob: null,
          busy: false,
          error: "Generation finished without an image",
        });
        return;
      }
      void (async () => {
        try {
          const processed = await processUserPetAtlasImage(url);
          if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = processed.objectUrl;
          setState({
            jobId: currentJobId,
            blob: processed,
            busy: false,
            error: null,
          });
        } catch (err) {
          setState({
            jobId: currentJobId,
            blob: null,
            busy: false,
            error: err instanceof Error ? err.message : "Couldn't process atlas",
          });
        }
      })();
    } else if (
      (job.status === "failed" || job.status === "canceled") &&
      !state.error
    ) {
      const message = job.error?.message ?? "Generation failed";
      setState((current) => ({ ...current, busy: false, error: message }));
    }
  }, [job, state.jobId, state.error]);

  // Cycle preview rows so the user can see the pet animate in different
  // states without having to interact with the preview.
  useEffect(() => {
    if (!state.blob) return;
    const id = window.setInterval(() => {
      setPreviewState((current) => {
        const idx = PREVIEW_STATES.indexOf(current);
        return PREVIEW_STATES[(idx + 1) % PREVIEW_STATES.length] ?? "idle";
      });
    }, 3500);
    return () => window.clearInterval(id);
  }, [state.blob]);

  const handleStartGeneration = useCallback(async () => {
    if (state.busy) return;
    const trimmedName = displayName.trim();
    const trimmedDescription = description.trim();
    if (!trimmedName) {
      showToast({ title: "Give your pet a name first", variant: "error" });
      return;
    }
    if (!trimmedDescription) {
      showToast({
        title: "Describe your pet so Stella knows what to draw",
        variant: "error",
      });
      return;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    processedJobsRef.current = new Set();
    setState({ jobId: null, blob: null, busy: true, error: null });
    try {
      const submission = await submitUserPetAtlasJob({
        name: trimmedName,
        description: trimmedDescription,
        style: style.trim() || undefined,
      });
      setState({
        jobId: submission.jobId,
        blob: null,
        busy: true,
        error: null,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Couldn't start generation";
      setState({ jobId: null, blob: null, busy: false, error: message });
      showToast({ title: message, variant: "error" });
    }
  }, [description, displayName, state.busy, style]);

  const handlePublish = useCallback(async () => {
    if (!state.blob) return;
    const trimmedName = displayName.trim();
    const trimmedDescription = description.trim();
    if (!trimmedName) {
      showToast({ title: "Give your pet a name", variant: "error" });
      return;
    }
    if (!trimmedDescription) {
      showToast({ title: "Add a description", variant: "error" });
      return;
    }
    setSubmitting(true);
    try {
      const petId = buildPetId(trimmedName);
      const upload = await createUploadUrl({
        petId,
        spritesheetSha256: state.blob.sha256,
        contentType: "image/webp",
      });
      await uploadUserPetSpritesheetToR2(state.blob.blob, upload.spritesheet);
      const created = await createPet({
        petId,
        displayName: trimmedName,
        description: trimmedDescription,
        ...(style.trim() ? { prompt: style.trim() } : {}),
        spritesheetUrl: upload.spritesheet.publicUrl,
        visibility,
      });
      writeSelectedPetId(created.petId);
      showToast({ title: `“${trimmedName}” is ready`, variant: "success" });
      onOpenChange(false);
      resetTransient();
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : "Couldn't save pet",
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    createPet,
    createUploadUrl,
    description,
    displayName,
    onOpenChange,
    resetTransient,
    state.blob,
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

  const ready = Boolean(state.blob);
  const generateLabel = state.busy
    ? "Generating…"
    : ready
    ? "Regenerate"
    : "Generate";

  const warningCount = state.blob?.warnings.length ?? 0;
  const warningSummary = useMemo(() => {
    if (!state.blob || warningCount === 0) return null;
    return state.blob.warnings.slice(0, 2).join(" ");
  }, [state.blob, warningCount]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="xl" className="user-pet-create-dialog">
        <DialogCloseButton disabled={submitting} />
        <DialogTitle>Create pet</DialogTitle>
        <DialogDescription>
          Describe your pet and Stella generates a full animated spritesheet.
          Idle, walking, waving, jumping — all in one image.
        </DialogDescription>
        <DialogBody className="user-pet-create-body">
          <div className="user-pet-create-preview">
            <div
              className="user-pet-create-stage"
              data-state={
                state.blob
                  ? "ready"
                  : state.busy
                  ? "busy"
                  : state.error
                  ? "error"
                  : "empty"
              }
            >
              {state.blob ? (
                <PetSprite
                  spritesheetUrl={state.blob.objectUrl}
                  state={previewState}
                  size={160}
                />
              ) : (
                <div className="user-pet-create-stage-placeholder">
                  {state.busy
                    ? "Painting your pet…"
                    : state.error
                    ? state.error
                    : "Your pet will animate here"}
                </div>
              )}
            </div>
            {state.blob ? (
              <div className="user-pet-create-state-row">
                {PREVIEW_STATES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="user-pet-create-state-pill"
                    data-active={previewState === s || undefined}
                    onClick={() => setPreviewState(s)}
                  >
                    {s.replace("-", " ")}
                  </button>
                ))}
              </div>
            ) : null}
            {warningSummary ? (
              <div className="user-pet-create-warning">{warningSummary}</div>
            ) : null}
          </div>

          <form
            className="user-pet-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handlePublish();
            }}
          >
            <TextField
              label="Pet name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="e.g. Sprig"
              maxLength={80}
              autoFocus
            />
            <label className="user-pet-create-field">
              <span className="user-pet-create-field-label">Describe your pet</span>
              <textarea
                className="user-pet-create-textarea"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="A leafy green sprout with bright eyes, small leafy ears, and a tiny acorn cap."
                rows={3}
                maxLength={500}
              />
            </label>
            <label className="user-pet-create-field">
              <span className="user-pet-create-field-label">
                Style notes <span className="user-pet-create-field-hint">optional</span>
              </span>
              <textarea
                className="user-pet-create-textarea"
                value={style}
                onChange={(event) => setStyle(event.target.value)}
                placeholder="Pixel art, thick outline, soft pastel palette…"
                rows={2}
                maxLength={2000}
              />
            </label>

            <div className="user-pet-create-field">
              <span className="user-pet-create-field-label">Visibility</span>
              <div className="user-pet-create-visibility">
                {VISIBILITY_OPTIONS.map((option) => (
                  <button
                    type="button"
                    key={option.value}
                    className="user-pet-create-visibility-pill"
                    data-active={visibility === option.value || undefined}
                    onClick={() => setVisibility(option.value)}
                  >
                    <span className="user-pet-create-visibility-title">
                      {option.title}
                    </span>
                    <span className="user-pet-create-visibility-sub">
                      {option.sub}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="user-pet-create-actions">
              <Button
                type="button"
                variant="secondary"
                size="large"
                className="pill-btn pill-btn--lg"
                onClick={() => void handleStartGeneration()}
                disabled={state.busy || submitting}
              >
                <Sparkles size={14} />
                {generateLabel}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="large"
                className="pill-btn pill-btn--primary pill-btn--lg"
                disabled={
                  !ready ||
                  !displayName.trim() ||
                  !description.trim() ||
                  submitting
                }
              >
                {submitting ? "Saving…" : "Save pet"}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
