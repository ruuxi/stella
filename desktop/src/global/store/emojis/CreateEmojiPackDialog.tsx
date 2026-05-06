import { useCallback, useState } from "react";
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
import { writeActiveEmojiPack } from "@/app/chat/emoji-sprites/active-emoji-pack";
import {
  emojiPackToActivePack,
  useGenerateEmojiPack,
  type EmojiPackVisibility,
} from "./emoji-pack-data";

type CreateEmojiPackDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

export function CreateEmojiPackDialog({
  open,
  onOpenChange,
}: CreateEmojiPackDialogProps) {
  const generatePack = useGenerateEmojiPack();
  const [prompt, setPrompt] = useState("");
  const [visibility, setVisibility] = useState<EmojiPackVisibility>("private");
  const [submitting, setSubmitting] = useState(false);

  const reset = useCallback(() => {
    setPrompt("");
    setVisibility("private");
    setSubmitting(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      showToast({
        title: "Tell Stella the vibe first",
        variant: "error",
      });
      return;
    }
    setSubmitting(true);
    try {
      const created = await generatePack({
        prompt: trimmedPrompt,
        visibility,
      });
      writeActiveEmojiPack(emojiPackToActivePack(created));
      showToast({ title: "Pack ready", variant: "success" });
      onOpenChange(false);
      reset();
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : "Couldn't create pack",
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }, [generatePack, onOpenChange, prompt, reset, visibility]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (submitting) return;
      onOpenChange(next);
    },
    [onOpenChange, submitting],
  );

  const handleDiscard = useCallback(() => {
    if (submitting) return;
    reset();
    onOpenChange(false);
  }, [onOpenChange, reset, submitting]);

  const hasDraft = prompt.trim().length > 0 || visibility !== "private";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent fit className="emoji-create-dialog">
        <DialogCloseButton disabled={submitting} />
        <DialogHeader>
          <DialogTitle className="emoji-create-title">
            Create emoji pack
          </DialogTitle>
          <p className="emoji-create-caption">
            Describe the vibe — Stella paints 108 custom emojis across three
            sheets and names the pack for you.
          </p>
        </DialogHeader>
        <DialogBody className="emoji-create-body">
          <section
            className="emoji-create-stage"
            aria-label="Generated emoji preview"
          >
            <div
              className="emoji-create-empty"
              data-state={submitting ? "busy" : "empty"}
            >
              <StellaLogoIcon size={22} aria-hidden />
              <span className="emoji-create-empty-text">
                {submitting
                  ? "Painting your pack…"
                  : "Stella's emojis appear after save"}
              </span>
            </div>
          </section>

          <form
            className="emoji-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
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
                    disabled={submitting}
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
              {hasDraft ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="normal"
                  className="pill-btn emoji-create-discard"
                  onClick={handleDiscard}
                  disabled={submitting}
                >
                  Discard
                </Button>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                size="normal"
                className="pill-btn pill-btn--primary pill-btn--lg"
                disabled={submitting || prompt.trim().length === 0}
              >
                <StellaLogoIcon size={14} aria-hidden />
                {submitting ? "Saving…" : "Save pack"}
              </Button>
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
