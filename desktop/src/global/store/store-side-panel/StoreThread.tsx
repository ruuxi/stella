import { FileText } from "lucide-react";
import {
  AssistantMessageRow,
  UserMessageRow,
  type AssistantRowViewModel,
  type UserRowViewModel,
} from "@/app/chat/MessageRow";
import { deriveBlueprintName } from "./format";
import type { StoreThreadMessage } from "./types";

function toUserRow(msg: StoreThreadMessage): UserRowViewModel {
  return {
    kind: "user",
    id: msg._id,
    text: msg.text,
    attachments: [],
  };
}

function toAssistantRow(msg: StoreThreadMessage): AssistantRowViewModel {
  return {
    kind: "assistant",
    id: msg._id,
    text: msg.text,
    cacheKey: msg._id,
    isAnimating: msg.pending === true,
  };
}

export function BlueprintPill({
  name,
  denied,
  published,
  onOpen,
}: {
  name: string;
  denied: boolean;
  published: boolean;
  onOpen: () => void;
}) {
  const tier = denied ? "denied" : published ? "published" : "review";
  const badgeLabel = denied
    ? "Denied"
    : published
      ? "Published"
      : "Review required";
  return (
    <button
      type="button"
      className="end-resource-card store-side-panel-blueprint-card"
      data-denied={denied || undefined}
      onClick={onOpen}
    >
      <span className="end-resource-card__icon">
        <FileText size={20} />
      </span>
      <span className="end-resource-card__text">
        <span className="end-resource-card__label">Blueprint draft</span>
        <span className="end-resource-card__action">{name}</span>
      </span>
      <span className="store-side-panel-blueprint-badge" data-tier={tier}>
        {badgeLabel}
      </span>
    </button>
  );
}

type StoreThreadProps = {
  messages: StoreThreadMessage[];
  onReviewBlueprint: (message: StoreThreadMessage) => void;
  /**
   * When true, suppress the "Pick changes above or just type…" empty
   * prompt. The parent passes this when the recent-changes list above
   * is itself empty — that list already shows a clear "no changes yet"
   * message and stacking another empty-state block under it reads as
   * noise.
   */
  hideEmptyPrompt?: boolean;
};

export function StoreThread({
  messages,
  onReviewBlueprint,
  hideEmptyPrompt = false,
}: StoreThreadProps) {
  if (messages.length === 0) {
    if (hideEmptyPrompt) {
      return <div className="store-side-panel-thread" />;
    }
    return (
      <div className="store-side-panel-thread">
        <div className="store-side-panel-thread-empty">
          Pick changes above or just type — Stella will help draft a blueprint
          to publish.
        </div>
      </div>
    );
  }

  return (
    <div className="store-side-panel-thread">
      <div className="chat-conversation-surface chat-conversation-surface--sidebar">
        {messages.map((message) => renderMessage(message, onReviewBlueprint))}
      </div>
    </div>
  );
}

function renderMessage(
  message: StoreThreadMessage,
  onReviewBlueprint: (message: StoreThreadMessage) => void,
) {
  if (message.role === "user") {
    const features = message.attachedFeatureNames ?? [];
    return (
      <div key={message._id}>
        {features.length > 0 ? (
          <div className="store-side-panel-user-chips">
            {features.map((name) => (
              <span key={name} className="store-side-panel-user-chip">
                {name}
              </span>
            ))}
          </div>
        ) : null}
        <UserMessageRow row={toUserRow(message)} />
      </div>
    );
  }

  if (message.isBlueprint) {
    const name = deriveBlueprintName(message.text);
    const row: AssistantRowViewModel = {
      ...toAssistantRow(message),
      text: "",
      customSlot: (
        <BlueprintPill
          name={name}
          denied={Boolean(message.denied)}
          published={Boolean(message.published)}
          onOpen={() => onReviewBlueprint(message)}
        />
      ),
      customSlotKey: `blueprint:${message._id}:${message.denied ? "denied" : message.published ? "published" : "review"}`,
    };
    return <AssistantMessageRow key={message._id} row={row} />;
  }

  if (message.pending && !message.text.trim()) {
    return (
      <div key={message._id} className="store-side-panel-drafting">
        Drafting your blueprint.
        <span className="store-side-panel-drafting-sub">
          This may take a couple of minutes.
        </span>
      </div>
    );
  }

  return (
    <AssistantMessageRow key={message._id} row={toAssistantRow(message)} />
  );
}
