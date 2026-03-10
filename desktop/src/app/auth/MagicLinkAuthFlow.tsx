import type { ReactNode } from "react";
import { cn } from "@/shared/lib/utils";
import { Button, type ButtonProps } from "@/ui/button";
import { TextField } from "@/ui/text-field";
import { useMagicLinkAuth } from "./useMagicLinkAuth";

type MagicLinkAuthFlowProps = {
  className?: string;
  intro?: ReactNode;
  mode?: "default" | "inline";
  emailLabel?: string;
  hideEmailLabel?: boolean;
  emailPlaceholder?: string;
  inputVariant?: "normal" | "ghost";
  inputClassName?: string;
  formClassName?: string;
  submitLabel?: string;
  sendingLabel?: string;
  buttonClassName?: string;
  buttonVariant?: ButtonProps["variant"];
  buttonSize?: ButtonProps["size"];
  autoFocus?: boolean;
  successClassName?: string;
  successMessage?: ReactNode;
  errorClassName?: string;
  sentClassName?: string;
  sentMessage?: ReactNode;
  retryClassName?: string;
  retryLabel?: string;
  skipClassName?: string;
  skipLabel?: string;
  onSkip?: () => void;
};

export function MagicLinkAuthFlow({
  className,
  intro,
  mode = "default",
  emailLabel = "Email",
  hideEmailLabel = false,
  emailPlaceholder = "you@example.com",
  inputVariant = "normal",
  inputClassName,
  formClassName,
  submitLabel = "Send sign-in email",
  sendingLabel = "Sending...",
  buttonClassName,
  buttonVariant = "primary",
  buttonSize = "normal",
  autoFocus = false,
  successClassName,
  successMessage = "Check your inbox for the sign-in link.",
  errorClassName,
  sentClassName,
  sentMessage = "Check your inbox for the sign-in link.",
  retryClassName,
  retryLabel = "Go Back",
  skipClassName,
  skipLabel = "Skip for now",
  onSkip,
}: MagicLinkAuthFlowProps) {
  const { email, setEmail, status, error, handleMagicLinkSubmit, reset } =
    useMagicLinkAuth();
  const isSent = status === "sent";

  return (
    <div className={cn(className)}>
      {mode === "inline" && isSent ? (
        <>
          {sentMessage ? (
            <div className={cn(sentClassName)}>{sentMessage}</div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            className={cn(retryClassName)}
            onClick={reset}
          >
            {retryLabel}
          </Button>
        </>
      ) : (
        <>
          {intro}
          <form className={cn(formClassName)} onSubmit={handleMagicLinkSubmit}>
            <TextField
              label={emailLabel}
              {...(hideEmailLabel ? { hideLabel: true } : {})}
              type="email"
              placeholder={emailPlaceholder}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              autoFocus={autoFocus}
              variant={inputVariant}
              className={cn(inputClassName)}
            />
            <Button
              type="submit"
              variant={buttonVariant}
              size={buttonSize}
              className={cn(buttonClassName)}
              disabled={status === "sending"}
            >
              {status === "sending" ? sendingLabel : submitLabel}
            </Button>
          </form>
          {mode === "default" && isSent && successMessage ? (
            <div className={cn(successClassName)}>{successMessage}</div>
          ) : null}
          {error ? <div className={cn(errorClassName)}>{error}</div> : null}
        </>
      )}
      {onSkip ? (
        <Button
          type="button"
          variant="ghost"
          className={cn(skipClassName)}
          onClick={onSkip}
        >
          {skipLabel}
        </Button>
      ) : null}
    </div>
  );
}
