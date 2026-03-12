import { cn } from "@/shared/lib/utils";
import { MagicLinkAuthFlow } from "./MagicLinkAuthFlow";

interface InlineAuthProps {
  className?: string;
  onSkip?: () => void;
}

export function InlineAuth({ className, onSkip }: InlineAuthProps) {
  return (
    <MagicLinkAuthFlow
      className={cn("onboarding-inline-auth", className)}
      mode="inline"
      intro={
        <div className="onboarding-inline-auth-label">
          Enter email to get started
        </div>
      }
      formClassName="onboarding-inline-auth-form"
      inputVariant="ghost"
      inputClassName="onboarding-inline-auth-input"
      hideEmailLabel={true}
      buttonClassName="onboarding-inline-auth-submit"
      buttonVariant="ghost"
      buttonSize="large"
      submitLabel="Send"
      sentClassName="onboarding-inline-auth-sent"
      sentMessage="Check your inbox or spam for your sign-in link"
      retryClassName="onboarding-inline-auth-retry"
      errorClassName="onboarding-inline-auth-error"
      skipClassName="onboarding-inline-auth-skip"
      onSkip={onSkip}
      autoFocus={true}
    />
  );
}
