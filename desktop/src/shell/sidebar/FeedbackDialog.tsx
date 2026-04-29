import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogCloseButton,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { TextField } from "@/ui/text-field";
import { showToast } from "@/ui/toast";

export interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Distinguishes the auto-prompted variant from the user-initiated dropdown
   * variant. The auto variant uses softer language and a "Not now" button
   * label so the prompt feels invited rather than demanded.
   */
  variant?: "manual" | "auto";
  /**
   * Fired after the backend accepts a submission. The Sidebar uses this to
   * reset the auto-prompt cooldown so a user who *just* sent feedback isn't
   * re-prompted in the same 24h window.
   */
  onSubmitted?: () => void;
}

const TITLE_BY_VARIANT: Record<NonNullable<FeedbackDialogProps["variant"]>, string> = {
  manual: "Send feedback",
  auto: "How's Stella going?",
};

const DESCRIPTION_BY_VARIANT: Record<
  NonNullable<FeedbackDialogProps["variant"]>,
  string
> = {
  manual:
    "Your message is sent anonymously — it isn't linked to your account.",
  auto: "Anything we should know? Sent anonymously — not linked to your account.",
};

const CANCEL_LABEL_BY_VARIANT: Record<
  NonNullable<FeedbackDialogProps["variant"]>,
  string
> = {
  manual: "Cancel",
  auto: "Not now",
};

export const FeedbackDialog = ({
  open,
  onOpenChange,
  variant = "manual",
  onSubmitted,
}: FeedbackDialogProps) => {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submitFeedback = useMutation(api.feedback.submitFeedback);

  // Reset transient state every time the dialog closes so the next open
  // starts from a clean textarea regardless of which trigger opened it.
  useEffect(() => {
    if (!open) {
      setText("");
      setSubmitting(false);
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await submitFeedback({ message: trimmed });
      onOpenChange(false);
      onSubmitted?.();
      showToast({
        title: "Feedback sent",
        description: "Thanks — every note helps us shape Stella.",
      });
    } catch (error) {
      const description =
        error instanceof Error ? error.message : "Please try again.";
      showToast({
        title: "Couldn't send feedback",
        description,
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }, [text, submitting, submitFeedback, onOpenChange, onSubmitted]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fit className="sidebar-feedback-dialog">
        <DialogHeader>
          <DialogTitle>{TITLE_BY_VARIANT[variant]}</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogDescription className="sidebar-feedback-description">
          {DESCRIPTION_BY_VARIANT[variant]}
        </DialogDescription>
        <div className="sidebar-feedback-body">
          <TextField
            multiline
            hideLabel
            label="Feedback"
            placeholder="Tell us what's working, what isn't, or what you'd love to see…"
            rows={5}
            maxLength={4000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoFocus
            disabled={submitting}
          />
        </div>
        <div className="sidebar-confirm-actions">
          <Button
            variant="ghost"
            size="large"
            className="pill-btn pill-btn--lg"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {CANCEL_LABEL_BY_VARIANT[variant]}
          </Button>
          <Button
            variant="primary"
            size="large"
            className="pill-btn pill-btn--primary pill-btn--lg"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={submitting || text.trim().length === 0}
          >
            {submitting ? "Sending…" : "Send"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
