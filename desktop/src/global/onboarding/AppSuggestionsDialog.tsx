import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogCloseButton,
  DialogTitle,
  DialogDescription,
} from "@/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { listLocalEvents } from "@/app/chat/services/local-chat-store";
import { Globe, Info, KeyRound, UserRound } from "lucide-react";
import {
  dispatchStellaSendMessage,
  WORKSPACE_CREATION_TRIGGER_KIND,
} from "@/shared/lib/stella-send-message";
import type {
  OnboardingAppBadge,
  OnboardingAppRecommendation,
} from "@/shared/contracts/onboarding";
import { WELCOME_DIALOG_CLOSED_EVENT } from "./WelcomeDialog";
import "./app-suggestions-dialog.css";

const APP_SUGGESTIONS_DIALOG_SEEN_KEY = "stella-app-suggestions-dialog-seen";
const WELCOME_DIALOG_SEEN_KEY = "stella-welcome-dialog-seen";
const POST_WELCOME_DELAY_MS = 3000;

const BADGE_ICON: Record<OnboardingAppBadge["icon"], typeof Globe> = {
  browser: Globe,
  account: UserRound,
  key: KeyRound,
  info: Info,
};

const hasBeenSeen = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
};

const markSeen = (key: string) => {
  try {
    localStorage.setItem(key, "true");
  } catch {
    // ignore
  }
};

function useAppRecommendations(
  conversationId: string | null,
  enabled: boolean,
): OnboardingAppRecommendation[] {
  const [recommendations, setRecommendations] = useState<
    OnboardingAppRecommendation[]
  >([]);

  useEffect(() => {
    if (!enabled || !conversationId) return;
    let cancelled = false;

    const load = async () => {
      try {
        const events = await listLocalEvents(conversationId, 200);
        if (cancelled) return;
        const event = events.findLast((e) => e.type === "app_recommendations");
        const payload = event?.payload as
          | { appRecommendations?: unknown }
          | undefined;
        if (Array.isArray(payload?.appRecommendations)) {
          setRecommendations(
            payload.appRecommendations as OnboardingAppRecommendation[],
          );
        }
      } catch {
        // silent — empty list keeps the dialog hidden
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [conversationId, enabled]);

  return recommendations;
}

type AppSuggestionsDialogProps = {
  conversationId: string | null;
};

/**
 * One-shot dialog shown three seconds after the user dismisses the
 * `WelcomeDialog`. Surfaces the LLM's three personalized app picks; clicking
 * one sends the prompt to the orchestrator (the click counts as consent for
 * the badged-up requirements like browser sign-ins or fetching API keys).
 *
 * Skipped silently if the user already saw it on a prior launch, if no
 * personalized recommendations were persisted (e.g. user skipped discovery),
 * or if the welcome dialog hasn't been dismissed yet this session.
 */
export function AppSuggestionsDialog({
  conversationId,
}: AppSuggestionsDialogProps) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(() => !hasBeenSeen(APP_SUGGESTIONS_DIALOG_SEEN_KEY));

  // Only fetch + render when this dialog hasn't been seen yet. Once it's
  // dismissed we disarm so the rest of the session is a no-op.
  const recommendations = useAppRecommendations(conversationId, armed);

  // Schedule the open after the welcome dialog finishes. Two paths: if the
  // welcome dialog was already seen on a prior launch, we start the timer
  // on mount; otherwise we wait for the welcome-dialog close event and
  // start it then.
  useEffect(() => {
    if (!armed) return;
    if (recommendations.length === 0) return;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (timeoutId !== null) return;
      timeoutId = setTimeout(() => {
        setOpen(true);
      }, POST_WELCOME_DELAY_MS);
    };

    if (hasBeenSeen(WELCOME_DIALOG_SEEN_KEY)) {
      schedule();
    }

    const handleWelcomeClosed = () => {
      schedule();
    };
    window.addEventListener(
      WELCOME_DIALOG_CLOSED_EVENT,
      handleWelcomeClosed,
    );

    return () => {
      window.removeEventListener(
        WELCOME_DIALOG_CLOSED_EVENT,
        handleWelcomeClosed,
      );
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [armed, recommendations.length]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setArmed(false);
    markSeen(APP_SUGGESTIONS_DIALOG_SEEN_KEY);
  }, []);

  const handlePick = useCallback(
    (recommendation: OnboardingAppRecommendation) => {
      handleClose();
      dispatchStellaSendMessage(
        {
          text: recommendation.prompt,
          uiVisibility: "visible",
          triggerKind: WORKSPACE_CREATION_TRIGGER_KIND,
          triggerSource: "app_suggestions_dialog",
        },
        { openPanel: true },
      );
    },
    [handleClose],
  );

  if (!open || recommendations.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent fit size="md" className="app-suggestions-dialog-content">
        <VisuallyHidden asChild>
          <DialogTitle>Apps Stella can build for you</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>
            Three personalized app suggestions Stella can build for you based on
            what you shared during setup.
          </DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="app-suggestions-dialog-close" />
        <DialogBody className="app-suggestions-dialog-body">
          <div className="app-suggestions-dialog-header">
            <p className="app-suggestions-dialog-eyebrow">Want me to build something?</p>
            <p className="app-suggestions-dialog-headline">
              Three ideas tailored to you
            </p>
          </div>

          <ul className="app-suggestions-dialog-list">
            {recommendations.map((recommendation) => (
              <li key={recommendation.label}>
                <button
                  type="button"
                  className="app-suggestions-dialog-card"
                  onClick={() => handlePick(recommendation)}
                >
                  <div className="app-suggestions-dialog-card-body">
                    <h3 className="app-suggestions-dialog-card-title">
                      {recommendation.label}
                    </h3>
                    {recommendation.description ? (
                      <p className="app-suggestions-dialog-card-description">
                        {recommendation.description}
                      </p>
                    ) : null}
                    {recommendation.badges.length > 0 ? (
                      <div className="app-suggestions-dialog-badges-row">
                        <span className="app-suggestions-dialog-badges-prefix">
                          Stella may:
                        </span>
                        <div className="app-suggestions-dialog-badges">
                          {recommendation.badges.map((badge, index) => {
                            const Icon = BADGE_ICON[badge.icon] ?? Info;
                            return (
                              <span
                                key={`${badge.icon}-${index}`}
                                className="app-suggestions-dialog-badge"
                              >
                                <Icon size={12} />
                                <span>{badge.label}</span>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <span className="app-suggestions-dialog-card-arrow">&rsaquo;</span>
                </button>
              </li>
            ))}
          </ul>

          <button
            type="button"
            className="app-suggestions-dialog-skip"
            onClick={handleClose}
          >
            Maybe later
          </button>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
