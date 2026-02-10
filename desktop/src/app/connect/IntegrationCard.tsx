import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/api";
import { Accordion } from "@/components/accordion";
import { Button } from "@/components/button";
import { showToast } from "@/components/toast";
import type { Integration } from "./integration-configs";
import {
  deployAndStartLocalBridge,
  type BridgeProvider,
} from "@/lib/bridge-local";

// ---------------------------------------------------------------------------
// Shared hooks
// ---------------------------------------------------------------------------

function useBridgeSetup(provider: BridgeProvider, isExpanded: boolean) {
  const setupBridge = useAction(api.channels.bridge.setupBridge);
  const getBridgeBundle = useAction(api.channels.bridge.getBridgeBundle);
  const runtimeMode = useQuery(api.data.preferences.getRuntimeMode);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isExpanded) return;

    let cancelled = false;

    (async () => {
      try {
        const result = await setupBridge({ provider });
        if (cancelled) return;

        if (result.status === "initializing" && runtimeMode !== "cloud_247") {
          await deployAndStartLocalBridge(provider, getBridgeBundle);
        }
        if (!cancelled) setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? "Failed to start bridge");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [provider, isExpanded, runtimeMode, setupBridge, getBridgeBundle]);

  return error;
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function ConnectedView({ integration }: { integration: Integration }) {
  const deleteConnection = useMutation(api.channels.utils.deleteConnection);
  const stopBridge = useAction(api.channels.bridge.stopBridge);
  const [disconnecting, setDisconnecting] = useState(false);

  const isBridge = integration.provider === "whatsapp" || integration.provider === "signal";

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      if (isBridge) {
        // Stop local process if running
        try {
          await window.electronAPI?.bridgeStop({ provider: integration.provider });
        } catch {
          // Ignore — may not be running locally
        }
        await stopBridge({ provider: integration.provider });
      }
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
  const createSlackInstallUrl = useMutation((api as any).data.integrations.createSlackInstallUrl);
  const [code, setCode] = useState<string | null>(null);
  const [botLink, setBotLink] = useState<string | null>(integration.botLink ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isExpanded) return;

    let cancelled = false;

    generateCode({ provider: integration.provider })
      .then((result) => {
        if (cancelled) return;
        setCode(result.code);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setCode(null);
        setError((err as Error).message ?? "Failed to generate code");
      });

    return () => {
      cancelled = true;
    };
  }, [isExpanded, integration.provider, generateCode]);

  useEffect(() => {
    if (!isExpanded) return;
    if (integration.provider !== "slack") {
      setBotLink(integration.botLink ?? null);
      return;
    }

    let cancelled = false;
    createSlackInstallUrl({})
      .then((result) => {
        if (cancelled) return;
        setBotLink(result.url);
      })
      .catch((err) => {
        if (cancelled) return;
        setBotLink(null);
        setError((err as Error).message ?? "Failed to prepare Slack install URL");
      });

    return () => {
      cancelled = true;
    };
  }, [createSlackInstallUrl, integration.botLink, integration.provider, isExpanded]);

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

      {botLink && (
        <a
          className="connect-bot-link"
          href={botLink}
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
  const error = useBridgeSetup("whatsapp", isExpanded);

  const qrCode = useQuery(
    api.channels.whatsapp.getQrCode,
    isExpanded ? {} : "skip",
  ) as string | null | undefined;

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
  const error = useBridgeSetup("signal", isExpanded);

  const linkUri = useQuery(
    api.channels.signal.getLinkUri,
    isExpanded ? {} : "skip",
  ) as string | null | undefined;

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
      return (
        <BotSetupView
          key={`${integration.provider}-${isExpanded ? "open" : "closed"}`}
          integration={integration}
          isExpanded={isExpanded}
        />
      );
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
