import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { motion } from "motion/react";
import { cn } from "@/shared/lib/utils";
import "./composer-primitives.css";

type ComposerFieldTone = "default" | "orb";

type ComposerButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  className?: string;
};

type ComposerFieldProps = {
  className?: string;
  tone?: ComposerFieldTone;
};

function AddIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export const ComposerAddButton = forwardRef<HTMLButtonElement, ComposerButtonProps>(
  function ComposerAddButton({ className, children, onClick, disabled, ...props }, ref) {
    const isDisabled = disabled ?? !onClick;

    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "chat-composer-icon-button chat-composer-icon-button--add",
          className,
        )}
        onClick={onClick}
        disabled={isDisabled}
        {...props}
      >
        {children ?? <AddIcon />}
      </button>
    );
  },
);

export const ComposerStopButton = forwardRef<HTMLButtonElement, ComposerButtonProps>(
  function ComposerStopButton({ className, children, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "chat-composer-icon-button chat-composer-icon-button--stop",
          className,
        )}
        {...props}
      >
        {children ?? <StopIcon />}
      </button>
    );
  },
);

type ComposerSubmitButtonProps = ComposerButtonProps & {
  animated?: boolean;
};

export function ComposerSubmitButton({
  animated = false,
  className,
  children,
  disabled,
  ...props
}: ComposerSubmitButtonProps) {
  const sharedClassName = cn(
    "chat-composer-icon-button chat-composer-icon-button--submit",
    className,
  );

  if (animated) {
    const canSubmit = !disabled;
    // Motion reuses onDrag* for pan gestures; strip DOM drag handlers so types align.
    const {
      onDrag: _d0,
      onDragCapture: _d0c,
      onDragStart: _ds,
      onDragStartCapture: _dsc,
      onDragEnd: _de,
      onDragEndCapture: _dec,
      onAnimationStart: _as,
      onAnimationStartCapture: _asc,
      onAnimationEnd: _ae,
      onAnimationEndCapture: _aec,
      onAnimationIteration: _ai,
      onAnimationIterationCapture: _aic,
      ...motionButtonProps
    } = props;

    return (
      <motion.button
        type="submit"
        className={sharedClassName}
        disabled={disabled}
        animate={{
          opacity: canSubmit ? 1 : 0.4,
          scale: canSubmit ? 1 : 0.92,
        }}
        whileHover={canSubmit ? { opacity: 0.9 } : {}}
        transition={{ type: "spring", duration: 0.2, bounce: 0 }}
        {...motionButtonProps}
      >
        {children ?? <SendIcon />}
      </motion.button>
    );
  }

  return (
    <button
      type="submit"
      className={sharedClassName}
      disabled={disabled}
      {...props}
    >
      {children ?? <SendIcon />}
    </button>
  );
}

export const ComposerTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & ComposerFieldProps
>(function ComposerTextarea({ className, tone = "default", ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "chat-composer-field chat-composer-textarea",
        tone === "orb" && "chat-composer-field--orb",
        className,
      )}
      {...props}
    />
  );
});

export const ComposerTextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & ComposerFieldProps
>(function ComposerTextInput({ className, tone = "default", ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "chat-composer-field chat-composer-text-input",
        tone === "orb" && "chat-composer-field--orb",
        className,
      )}
      {...props}
    />
  );
});
