import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { LLM_PROVIDERS } from "@/global/settings/lib/llm-providers";
import {
  PROVIDER_CONNECTED_EVENT,
  type ProviderConnectedEventDetail,
} from "@/global/settings/hooks/use-llm-credentials";
import type { RealtimeVoicePreferences } from "../../../../runtime/contracts/local-preferences";
import "./ProviderConnectedDialog.css";

const ASSISTANT_AGENT_KEYS = ["orchestrator", "general"] as const;

interface ImageGenPrefs {
  provider: "stella" | "openai" | "openrouter" | "fal";
  model?: string;
}

interface LocalPrefsPatch {
  modelOverrides?: Record<string, string>;
  imageGeneration?: ImageGenPrefs;
  realtimeVoice?: RealtimeVoicePreferences;
}

/**
 * Some providers can serve more than one of Stella's surfaces (assistant
 * model, image generation, realtime voice). This table answers "if the user
 * just connected provider X, which surfaces could we offer to route through
 * it?". OpenAI is the obvious one — it covers all three.
 */
const PROVIDER_SURFACES: Record<
  string,
  {
    assistant: boolean;
    image: "openai" | "openrouter" | "fal" | null;
    voice: "openai" | "xai" | "inworld" | null;
  }
> = {
  openai: { assistant: true, image: "openai", voice: "openai" },
  anthropic: { assistant: true, image: null, voice: null },
  google: { assistant: true, image: null, voice: null },
  openrouter: { assistant: true, image: "openrouter", voice: null },
  fal: { assistant: false, image: "fal", voice: null },
  xai: { assistant: true, image: null, voice: "xai" },
  inworld: { assistant: false, image: null, voice: "inworld" },
};

interface Stage {
  detail: ProviderConnectedEventDetail;
  surfaces: (typeof PROVIDER_SURFACES)[string];
  providerLabel: string;
}

/**
 * Lives near the app root, listens for `stella:llm-provider-connected`, and
 * offers a single confirmation that routes the assistant / image / voice
 * surfaces through the just-connected provider in one shot. Replaces the
 * old "set each surface manually" flow that made BYOK feel hostile.
 */
export function ProviderConnectedDialog() {
  const [stage, setStage] = useState<Stage | null>(null);
  const [assistant, setAssistant] = useState(true);
  const [image, setImage] = useState(true);
  const [voice, setVoice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: CustomEvent<ProviderConnectedEventDetail>) => {
      const detail = event.detail;
      const surfaces = PROVIDER_SURFACES[detail.provider];
      if (!surfaces) return;

      // Only ask the user "where should this provider take over?" when more
      // than one surface is actually on the table. The dialog's whole reason
      // to exist is multi-surface ambiguity (OpenAI = assistant + image +
      // voice, OpenRouter = assistant + image). For assistant-only providers
      // (Anthropic, Google) we don't change the active assistant on connect
      // — the user just wanted credentials registered, and switching their
      // chat model behind a confirmation feels invasive. For image-only or
      // voice-only providers (fal) the choice is binary and unambiguous, so
      // we silently apply the preference and skip the dialog.
      const offeredCount =
        (surfaces.assistant ? 1 : 0) +
        (surfaces.image ? 1 : 0) +
        (surfaces.voice ? 1 : 0);
      if (offeredCount === 0) return;
      if (offeredCount === 1) {
        if (!surfaces.assistant && (surfaces.image || surfaces.voice)) {
          const patch: LocalPrefsPatch = {};
          if (surfaces.image) {
            patch.imageGeneration = { provider: surfaces.image };
          }
          if (surfaces.voice) {
            patch.realtimeVoice = { provider: surfaces.voice };
          }
          void window.electronAPI?.system
            ?.setLocalModelPreferences?.(patch)
            .then(() => {
              window.dispatchEvent(
                new CustomEvent("stella:local-model-preferences-changed"),
              );
            });
        }
        return;
      }

      const llmEntry = LLM_PROVIDERS.find(
        (entry) => entry.key === detail.provider,
      );
      setStage({
        detail,
        surfaces,
        providerLabel: llmEntry?.label ?? detail.provider,
      });
      setAssistant(surfaces.assistant);
      setImage(Boolean(surfaces.image));
      setVoice(Boolean(surfaces.voice));
      setError(null);
    };
    window.addEventListener(PROVIDER_CONNECTED_EVENT, handler);
    return () => window.removeEventListener(PROVIDER_CONNECTED_EVENT, handler);
  }, []);

  const onClose = useCallback(() => {
    setStage(null);
    setError(null);
  }, []);

  const onApply = useCallback(async () => {
    if (!stage) return;
    const { detail, surfaces } = stage;
    const patch: LocalPrefsPatch = {};

    if (surfaces.assistant && assistant) {
      const existing =
        (await window.electronAPI?.system?.getLocalModelPreferences?.())
          ?.modelOverrides ?? {};
      const next = { ...existing };
      // Use a sentinel model id that maps to "let the provider pick" via
      // the existing override pathway: there is no single canonical model
      // id per provider here, so we instead pick the provider's first
      // documented Stella-side default. If the user wants a specific
      // model later, they can pick it from the picker's "More options".
      // Falling back to the provider key itself works because the runtime
      // resolves bare provider names to their default upstream.
      const defaultModelByProvider: Record<string, string> = {
        openai: "openai/gpt-5.5",
        anthropic: "anthropic/claude-opus-4.7",
        google: "google/gemini-3.1-pro",
        openrouter: "openrouter/anthropic/claude-opus-4.7",
        xai: "xai/grok-4",
      };
      const model = defaultModelByProvider[detail.provider];
      if (model) {
        for (const key of ASSISTANT_AGENT_KEYS) {
          next[key] = model;
        }
        patch.modelOverrides = next;
      }
    }

    if (surfaces.image && image) {
      patch.imageGeneration = { provider: surfaces.image };
    }

    if (surfaces.voice && voice) {
      patch.realtimeVoice = { provider: surfaces.voice };
    }

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await window.electronAPI?.system?.setLocalModelPreferences?.(patch);
      window.dispatchEvent(
        new CustomEvent("stella:local-model-preferences-changed"),
      );
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to apply provider settings.",
      );
    } finally {
      setBusy(false);
    }
  }, [assistant, image, onClose, stage, voice]);

  const anyChecked = useMemo(() => {
    if (!stage) return false;
    const { surfaces } = stage;
    return (
      (surfaces.assistant && assistant) ||
      (Boolean(surfaces.image) && image) ||
      (Boolean(surfaces.voice) && voice)
    );
  }, [assistant, image, stage, voice]);

  if (!stage) return null;
  const { providerLabel, surfaces } = stage;

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="provider-connected-dialog">
        <DialogHeader>
          <DialogTitle>Use {providerLabel} for Stella?</DialogTitle>
          <DialogDescription>
            {providerLabel} can power more than one part of Stella. Pick where
            you&rsquo;d like it to take over — Stella keeps doing the rest.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="provider-connected-dialog-body">
          {surfaces.assistant ? (
            <label className="provider-connected-row">
              <input
                type="checkbox"
                checked={assistant}
                onChange={(event) => setAssistant(event.target.checked)}
              />
              <span>
                <span className="provider-connected-row-label">Assistant</span>
                <span className="provider-connected-row-desc">
                  Route Stella&rsquo;s chat assistant through {providerLabel}.
                </span>
              </span>
            </label>
          ) : null}
          {surfaces.image ? (
            <label className="provider-connected-row">
              <input
                type="checkbox"
                checked={image}
                onChange={(event) => setImage(event.target.checked)}
              />
              <span>
                <span className="provider-connected-row-label">Image</span>
                <span className="provider-connected-row-desc">
                  Generate images through your {providerLabel} account.
                </span>
              </span>
            </label>
          ) : null}
          {surfaces.voice ? (
            <label className="provider-connected-row">
              <input
                type="checkbox"
                checked={voice}
                onChange={(event) => setVoice(event.target.checked)}
              />
              <span>
                <span className="provider-connected-row-label">Voice</span>
                <span className="provider-connected-row-desc">
                  Use {providerLabel} for realtime voice conversations.
                </span>
              </span>
            </label>
          ) : null}
          {error ? (
            <p className="provider-connected-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="provider-connected-actions">
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={onClose}
              disabled={busy}
            >
              Skip
            </Button>
            <Button
              type="button"
              variant="primary"
              className="pill-btn pill-btn--primary"
              onClick={() => void onApply()}
              disabled={busy || !anyChecked}
            >
              {busy ? "Applying…" : "Apply"}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
