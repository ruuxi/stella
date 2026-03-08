import {
  memo,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/api";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import type { Integration } from "./integration-configs";
import {
  deployAndStartLocalBridge,
  type BridgeProvider,
} from "@/platform/electron/bridge-local";
import { sanitizeExternalLinkUrl } from "@/shared/lib/url-safety";

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isConnectedConnection(connection: unknown) {
  return connection !== null && connection !== undefined;
}

function useIntegrationConnectionStatus(provider: string) {
  const connection = useQuery(api.channels.utils.getConnection, { provider });
  return isConnectedConnection(connection);
}

function isBridgeProvider(provider: string): provider is BridgeProvider {
  return provider === "whatsapp" || provider === "signal";
}

function SetupContent({
  instructions,
  error,
  children,
}: {
  instructions: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <>
      <p className="connect-instructions">{instructions}</p>
      {error ? <div className="connect-error">{error}</div> : null}
      {children}
    </>
  );
}

function useBridgeSetup(provider: BridgeProvider, isExpanded: boolean) {
  const setupBridge = useAction(api.channels.bridge_actions.setupBridge);
  const getBridgeBundle = useAction(api.channels.bridge_actions.getBridgeBundle);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isExpanded) return;

    let cancelled = false;

    (async () => {
      try {
        const result = await setupBridge({ provider });
        if (cancelled) return;

        const electronApi = window.electronAPI;
        const bridgeStatus = electronApi
          ? await electronApi.system.bridgeStatus({ provider }).catch(() => null)
          : null;
        if (cancelled) return;

        const shouldStartLocal =
          result.status === "initializing" || !bridgeStatus?.running;
        if (shouldStartLocal) {
          await deployAndStartLocalBridge(provider, getBridgeBundle);
        }
        if (!cancelled) setError(null);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, "Failed to start bridge"));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [provider, isExpanded, setupBridge, getBridgeBundle]);

  return error;
}

function ConnectedView({ integration }: { integration: Integration }) {
  const deleteConnection = useMutation(api.channels.utils.deleteConnection);
  const stopBridge = useAction(api.channels.bridge_actions.stopBridge);
  const [disconnecting, setDisconnecting] = useState(false);

  const isBridge = isBridgeProvider(integration.provider);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      if (isBridge) {
        try {
          await window.electronAPI?.system.bridgeStop({ provider: integration.provider });
        } catch {
          // Ignore; bridge may not be running locally.
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
  const createSlackInstallUrl = useMutation(api.data.integrations.createSlackInstallUrl);
  const [code, setCode] = useState<string | null>(null);
  const [botLink, setBotLink] = useState<string | null>(() =>
    sanitizeExternalLinkUrl(integration.botLink),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isExpanded) return;

    let cancelled = false;

    const staticBotLink = sanitizeExternalLinkUrl(integration.botLink);

    const loadBotSetup = async () => {
      const codePromise = generateCode({ provider: integration.provider });
      const botLinkPromise =
        integration.provider === "slack"
          ? createSlackInstallUrl({}).then((result) => {
              const safeUrl = sanitizeExternalLinkUrl(result.url);
              if (!safeUrl) {
                throw new Error("Received an invalid install link");
              }
              return safeUrl;
            })
          : Promise.resolve(staticBotLink);

      const [codeResult, botLinkResult] = await Promise.allSettled([
        codePromise,
        botLinkPromise,
      ]);
      if (cancelled) return;

      const nextCode = codeResult.status === "fulfilled" ? codeResult.value.code : null;
      const nextBotLink =
        botLinkResult.status === "fulfilled"
          ? botLinkResult.value
          : integration.provider === "slack"
            ? null
            : staticBotLink;
      setCode(nextCode);
      setBotLink(nextBotLink);

      if (codeResult.status === "rejected") {
        setError(getErrorMessage(codeResult.reason, "Failed to generate code"));
        return;
      }

      if (botLinkResult.status === "rejected") {
        setError(
          getErrorMessage(
            botLinkResult.reason,
            "Failed to prepare Slack install URL",
          ),
        );
        return;
      }

      setError(null);
    };

    void loadBotSetup();

    return () => {
      cancelled = true;
    };
  }, [
    createSlackInstallUrl,
    generateCode,
    integration.botLink,
    integration.provider,
    isExpanded,
  ]);

  const handleCopy = useCallback(() => {
    if (code) {
      navigator.clipboard.writeText(code);
      showToast("Code copied to clipboard");
    }
  }, [code]);

  return (
    <SetupContent instructions={integration.instructions} error={error}>
      <>
        {error ? null : (
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

        {botLink ? (
          <a
            className="connect-bot-link"
            href={botLink}
            target="_blank"
            rel="noopener noreferrer"
          >
            Find bot on {integration.displayName} &#8599;
          </a>
        ) : null}
      </>
    </SetupContent>
  );
}

function WhatsAppBridgeView({ isExpanded }: { isExpanded: boolean }) {
  const error = useBridgeSetup("whatsapp", isExpanded);

  const qrCode = useQuery(
    api.channels.whatsapp.getQrCode,
    isExpanded ? {} : "skip",
  ) as string | null | undefined;

  return (
    <SetupContent
      instructions="Scan the QR code below with your WhatsApp app to link your account."
      error={error}
    >
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
    </SetupContent>
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
    <SetupContent
      instructions="Open Signal on your phone, go to Settings > Linked Devices, then scan or tap the link below."
      error={error}
    >
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
    </SetupContent>
  );
}

type IntegrationGridCardProps = {
  integration: Integration;
  isSelected: boolean;
  onClick: () => void;
};

function IntegrationGridCardComponent({
  integration,
  isSelected,
  onClick,
}: IntegrationGridCardProps) {
  const isConnected = useIntegrationConnectionStatus(integration.provider);

  return (
    <button
      className={`connect-grid-card${isSelected ? " connect-grid-card-selected" : ""}`}
      onClick={onClick}
      type="button"
    >
      <span className="connect-grid-card-icon">{integration.icon}</span>
      <span className="connect-grid-card-name">{integration.displayName}</span>
      {isConnected && (
        <span className="connect-grid-card-badge">
          <span className="connect-grid-card-badge-dot" />
        </span>
      )}
    </button>
  );
}
export const IntegrationGridCard = memo(IntegrationGridCardComponent);
IntegrationGridCard.displayName = "IntegrationGridCard";

export function IntegrationDetailArea({
  integration,
}: {
  integration: Integration;
}) {
  const isConnected = useIntegrationConnectionStatus(integration.provider);
  let detailContent: ReactNode = null;

  if (isConnected) {
    detailContent = <ConnectedView integration={integration} />;
  } else if (integration.type === "bot") {
    detailContent = <BotSetupView integration={integration} isExpanded={true} />;
  } else if (integration.provider === "whatsapp") {
    detailContent = <WhatsAppBridgeView isExpanded={true} />;
  } else {
    detailContent = <SignalBridgeView isExpanded={true} />;
  }

  return (
    <div className="connect-detail-area">
      <div className="connect-detail-header">
        <span className="connect-grid-card-icon">{integration.icon}</span>
        <span className="connect-detail-name">{integration.displayName}</span>
      </div>
      <div className="connect-detail-body">{detailContent}</div>
    </div>
  );
}

