/**
 * Inline connect card: an agent asked (via `stella-connect
 * request-connection`) to use an integration that isn't connected yet.
 * Rendered in the flow of the chat surfaces, pinned above the composer
 * while the agent's turn is blocked on the answer. Connect launches the
 * same Composio/OAuth flow as the Store (browser hand-off, no modal);
 * Not now resolves a decline that the runtime persists so the offer is
 * never repeated.
 */

import { useState } from "react";
import { AlertCircle, Check, Globe } from "@/ui/icons";
import { Button } from "@/ui/button";
import {
  respondToConnectorConnect,
  useConnectorConnectRequest,
} from "@/features/chat/connector-connect-store";
import "./connector-connect-card.css";

export const ConnectorConnectCard = ({
  compact = false,
  conversationId,
}: {
  compact?: boolean;
  /** Scope: only requests for this chat (or unscoped ones) render here. */
  conversationId?: string | null;
}) => {
  const request = useConnectorConnectRequest(conversationId);
  const [iconFailed, setIconFailed] = useState(false);
  if (!request) return null;

  const isBrowserExtension = request.kind === "browser-extension";
  const showIconImage = Boolean(request.iconUrl) && !iconFailed;
  const sub =
    request.phase === "connecting"
      ? isBrowserExtension
        ? "Add the extension from the Chrome Web Store tab that just opened. Stella continues automatically once it's installed."
        : `Finish signing in to ${request.name} in your browser. Stella will continue once it's approved.`
      : request.phase === "connected"
        ? isBrowserExtension
          ? "Extension detected. Stella is continuing with your request."
          : "Connected. Stella is continuing with your request."
        : request.phase === "error"
          ? (request.message ?? `Could not connect ${request.name}.`)
          : (request.reason ?? request.description ?? undefined);

  const title =
    request.phase === "connected"
      ? `${request.name} connected`
      : request.phase === "connecting"
        ? `Waiting for ${request.name}`
        : request.phase === "error"
          ? `Couldn't connect ${request.name}`
          : isBrowserExtension
            ? `Connect the ${request.name}?`
            : `Connect ${request.name}?`;

  return (
    <div
      className={`connector-connect-card connector-connect-card--${request.phase}${compact ? " connector-connect-card--compact" : ""}`}
      role="status"
    >
      <div className="connector-connect-card__icon" aria-hidden>
        {request.phase === "connected" ? (
          <Check size={compact ? 14 : 16} />
        ) : request.phase === "error" ? (
          <AlertCircle size={compact ? 14 : 16} />
        ) : showIconImage ? (
          <img
            src={request.iconUrl}
            alt=""
            onError={() => setIconFailed(true)}
          />
        ) : (
          <Globe size={compact ? 14 : 16} />
        )}
      </div>
      <div className="connector-connect-card__body">
        <p className="connector-connect-card__title">{title}</p>
        {sub ? <p className="connector-connect-card__sub">{sub}</p> : null}
      </div>
      {request.phase === "offer" ? (
        <div className="connector-connect-card__actions">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn connector-connect-card__decline"
            onClick={() => respondToConnectorConnect(request.requestId, "decline")}
          >
            Not now
          </Button>
          <Button
            type="button"
            variant="primary"
            className="pill-btn pill-btn--primary connector-connect-card__accept"
            onClick={() => respondToConnectorConnect(request.requestId, "accept")}
          >
            {isBrowserExtension ? "Install" : "Connect"}
          </Button>
        </div>
      ) : request.phase === "connecting" ? (
        <div className="connector-connect-card__actions">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn connector-connect-card__decline"
            onClick={() => respondToConnectorConnect(request.requestId, "cancel")}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
};
