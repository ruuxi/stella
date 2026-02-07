import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/api";
import { Accordion } from "@/components/accordion";
import { Button } from "@/components/button";
import { showToast } from "@/components/toast";
import type { Integration } from "./integration-configs";

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function ConnectedView({ integration }: { integration: Integration }) {
  const deleteConnection = useMutation(api.channels.utils.deleteConnection);
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await deleteConnection({ provider: integration.provider });
      showToast(`Disconnected from ${integration.displayName}`);
    } catch {
      showToast(`Failed to disconnect from ${integration.displayName}`);
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="connect-status-row">
      <span className="connect-status">
        <span className="connect-status-dot" />
        Connected
      </span>
      <Button
        variant="ghost"
        size="small"
        onClick={handleDisconnect}
        disabled={disconnecting}
      >
        {disconnecting ? "Disconnecting..." : "Disconnect"}
      </Button>
    </div>
  );
}

function BotSetupView({
  integration,
  isExpanded,
}: {
  integration: Integration;
  isExpanded: boolean;
}) {
  const generateCode = useMutation(api.channels.utils.generateLinkCode);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isExpanded) {
      setCode(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setError(null);

    generateCode({ provider: integration.provider })
      .then((result) => {
        if (!cancelled) setCode(result.code);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message ?? "Failed to generate code");
      });

    return () => {
      cancelled = true;
    };
  }, [isExpanded, integration.provider, generateCode]);

  const handleCopy = useCallback(() => {
    if (code) {
      navigator.clipboard.writeText(code);
      showToast("Code copied to clipboard");
    }
  }, [code]);

  return (
    <>
      <p className="connect-instructions">{integration.instructions}</p>

      {error && <div className="connect-error">{error}</div>}

      {!error && (
        <div className="connect-code-row">
          {code ? (
            <>
              <span className="connect-code">{code}</span>
              <Button variant="ghost" size="small" onClick={handleCopy}>
                Copy
              </Button>
            </>
          ) : (
            <div className="connect-skeleton connect-skeleton-code" />
          )}
        </div>
      )}

      {integration.botLink && (
        <a
          className="connect-bot-link"
          href={integration.botLink}
          target="_blank"
          rel="noopener noreferrer"
        >
          Find bot on {integration.displayName} &#8599;
        </a>
      )}
    </>
  );
}

function WhatsAppBridgeView({ isExpanded }: { isExpanded: boolean }) {
  const setupBridge = useAction(api.channels.bridge.setupBridge);
  const [error, setError] = useState<string | null>(null);

  const qrCode = useQuery(
    api.channels.whatsapp.getQrCode,
    isExpanded ? {} : "skip",
  ) as string | null | undefined;

  useEffect(() => {
    if (!isExpanded) {
      setError(null);
      return;
    }

    let cancelled = false;

    setupBridge({ provider: "whatsapp" })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message ?? "Failed to start bridge");
      });

    return () => {
      cancelled = true;
    };
  }, [isExpanded, setupBridge]);

  return (
    <>
      <p className="connect-instructions">
        Scan the QR code below with your WhatsApp app to link your account.
      </p>

      {error && <div className="connect-error">{error}</div>}

      <div className="connect-qr">
        {qrCode ? (
          <img
            src={qrCode}
            alt="WhatsApp QR Code"
            width={200}
            height={200}
          />
        ) : (
          <div className="connect-skeleton connect-skeleton-qr" />
        )}
      </div>
    </>
  );
}

function SignalBridgeView({ isExpanded }: { isExpanded: boolean }) {
  const setupBridge = useAction(api.channels.bridge.setupBridge);
  const [error, setError] = useState<string | null>(null);

  const linkUri = useQuery(
    api.channels.signal.getLinkUri,
    isExpanded ? {} : "skip",
  ) as string | null | undefined;

  useEffect(() => {
    if (!isExpanded) {
      setError(null);
      return;
    }

    let cancelled = false;

    setupBridge({ provider: "signal" })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message ?? "Failed to start bridge");
      });

    return () => {
      cancelled = true;
    };
  }, [isExpanded, setupBridge]);

  const handleCopy = useCallback(() => {
    if (linkUri) {
      navigator.clipboard.writeText(linkUri);
      showToast("Link copied to clipboard");
    }
  }, [linkUri]);

  return (
    <>
      <p className="connect-instructions">
        Open Signal on your phone, go to Settings &gt; Linked Devices, then scan or tap
        the link below.
      </p>

      {error && <div className="connect-error">{error}</div>}

      {linkUri ? (
        <div className="connect-link-uri">
          <div className="connect-link-uri-value">{linkUri}</div>
          <Button variant="ghost" size="small" onClick={handleCopy}>
            Copy link
          </Button>
        </div>
      ) : (
        <div className="connect-skeleton connect-skeleton-link" />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// IntegrationCard
// ---------------------------------------------------------------------------

export function IntegrationCard({
  integration,
  isExpanded,
}: {
  integration: Integration;
  isExpanded: boolean;
}) {
  const connection = useQuery(api.channels.utils.getConnection, {
    provider: integration.provider,
  });
  const isConnected = connection !== null && connection !== undefined;

  const renderContent = () => {
    if (isConnected) {
      return <ConnectedView integration={integration} />;
    }
    if (integration.type === "bot") {
      return <BotSetupView integration={integration} isExpanded={isExpanded} />;
    }
    if (integration.provider === "whatsapp") {
      return <WhatsAppBridgeView isExpanded={isExpanded} />;
    }
    return <SignalBridgeView isExpanded={isExpanded} />;
  };

  return (
    <Accordion.Item value={integration.provider}>
      <Accordion.Trigger className="connect-trigger">
        <span className="connect-trigger-icon">{integration.icon}</span>
        <span className="connect-trigger-name">{integration.displayName}</span>
        {isConnected && (
          <span className="connect-trigger-badge">
            <span className="connect-trigger-badge-dot" />
            Connected
          </span>
        )}
      </Accordion.Trigger>
      <Accordion.Content>
        <div className="connect-content">{renderContent()}</div>
      </Accordion.Content>
    </Accordion.Item>
  );
}
