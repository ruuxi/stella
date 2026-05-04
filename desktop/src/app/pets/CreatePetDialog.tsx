import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/api";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
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
import { PetSprite } from "@/shell/pet/PetSprite";
import type { PetAnimationState } from "@/shared/contracts/pet";
import { writeSelectedPetId } from "@/shell/pet/pet-preferences";
import { addInstalledPet } from "./installed-pets";
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

const buildPetId = (): string => {
  const suffix = Date.now().toString(36).slice(-6);
  return `pet-${suffix}`;
};

const isMediaJobSnapshot = (
  value: unknown,
): value is { status?: string; output?: unknown; error?: { message?: string } } =>
  Boolean(value) && typeof value === "object";

export function CreatePetDialog({ open, onOpenChange }: CreatePetDialogProps) {
  const { createPet } = useUserPetMutations();
  const createUploadUrl = useCreateUserPetUploadUrl();

  const [state, setState] = useState<GenerationState>({ ...EMPTY });
  const [prompt, setPrompt] = useState("");
  const [visibility, setVisibility] = useState<UserPetVisibility>("private");
  const [submitting, setSubmitting] = useState(false);
  const [previewState, setPreviewState] =
    useState<PetAnimationState>("idle");

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
    setState({ ...EMPTY });
    setPrompt("");
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
          for (const u of objectUrlsRef.current) URL.revokeObjectURL(u);
          objectUrlsRef.current = [processed.objectUrl];
          if (processed.preview) {
            objectUrlsRef.current.push(processed.preview.objectUrl);
          }
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

  // Cycle preview rows so the user sees the pet animate through a few
  // states without poking the preview pills.
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
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      showToast({
        title: "Describe your pet so Stella knows what to draw",
        variant: "error",
      });
      return;
    }
    for (const u of objectUrlsRef.current) URL.revokeObjectURL(u);
    objectUrlsRef.current = [];
    processedJobsRef.current = new Set();
    setState({ jobId: null, blob: null, busy: true, error: null });
    try {
      const submission = await submitUserPetAtlasJob({
        name: "",
        description: trimmedPrompt,
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
  }, [prompt, state.busy]);

  const handlePublish = useCallback(async () => {
    if (!state.blob) return;
    const trimmedPrompt = prompt.trim() || "A custom Stella pet.";
    setSubmitting(true);
    try {
      const petId = buildPetId();
      const previewBlob = state.blob.preview;
      const upload = await createUploadUrl({
        petId,
        spritesheetSha256: state.blob.sha256,
        ...(previewBlob ? { previewSha256: previewBlob.sha256 } : {}),
        contentType: "image/webp",
      });
      const uploads: Array<Promise<void>> = [
        uploadUserPetSpritesheetToR2(state.blob.blob, upload.spritesheet),
      ];
      if (previewBlob && upload.preview) {
        uploads.push(
          uploadUserPetSpritesheetToR2(previewBlob.blob, upload.preview),
        );
      }
      await Promise.all(uploads);
      const created = await createPet({
        petId,
        // Backend enrichment renames this to a friendly Stella-generated
        // name + description + tags right after insert.
        displayName: "Stella pet",
        description: trimmedPrompt,
        prompt: trimmedPrompt,
        spritesheetUrl: upload.spritesheet.publicUrl,
        ...(upload.preview ? { previewUrl: upload.preview.publicUrl } : {}),
        visibility,
      });
      addInstalledPet(created.petId);
      writeSelectedPetId(created.petId);
      showToast({ title: "Pet ready", variant: "success" });
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
    onOpenChange,
    prompt,
    resetTransient,
    state.blob,
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

  const warningSummary = useMemo(() => {
    if (!state.blob || state.blob.warnings.length === 0) return null;
    return state.blob.warnings.slice(0, 2).join(" ");
  }, [state.blob]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="user-pet-create-dialog">
        <DialogCloseButton disabled={submitting} />
        <DialogHeader>
          <DialogTitle className="user-pet-create-title">
            Create a pet
          </DialogTitle>
          <p className="user-pet-create-caption">
            Describe your pet — Stella draws a full animated spritesheet and
            names it for you.
          </p>
        </DialogHeader>
        <DialogBody className="user-pet-create-body">
          <section
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
                size={180}
              />
            ) : (
              <div className="user-pet-create-empty">
                <StellaLogoIcon size={22} aria-hidden />
                <span className="user-pet-create-empty-text">
                  {state.busy
                    ? "Painting your pet…"
                    : state.error
                    ? state.error
                    : "Your pet appears here"}
                </span>
              </div>
            )}
          </section>

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

          <form
            className="user-pet-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!ready) {
                void handleStartGeneration();
                return;
              }
              void handlePublish();
            }}
          >
            <label className="user-pet-create-field">
              <span className="user-pet-create-field-label">
                How should your pet look?
              </span>
              <textarea
                className="user-pet-create-textarea"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="A leafy green sprout with bright eyes, small leaf ears, and a tiny acorn cap."
                rows={3}
                maxLength={2000}
                autoFocus
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
                size="normal"
                className="pill-btn pill-btn--lg"
                onClick={() => void handleStartGeneration()}
                disabled={
                  state.busy || submitting || prompt.trim().length === 0
                }
              >
                <StellaLogoIcon size={14} aria-hidden />
                {generateLabel}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="normal"
                className="pill-btn pill-btn--primary pill-btn--lg"
                disabled={!ready || submitting}
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
