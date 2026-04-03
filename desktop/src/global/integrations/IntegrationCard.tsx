import {
  memo,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/api";
import { Button } from "@/ui/button";
import { showToast } from "@/ui/toast";
import type { Integration } from "./integration-configs";
import { sanitizeExternalLinkUrl } from "@/shared/lib/url-safety";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function useIntegrationConnectionStatus(provider: string) {
  const connection = useQuery(api.channels.utils.getConnection, { provider });
  return connection != null;
}

type BotSetupState =
  | {
      status: "loading";
      botLink: string | null;
    }
  | {
      status: "ready";
      code: string;
      botLink: string | null;
    }
  | {
      status: "error";
      message: string;
      botLink: string | null;
    };

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
  const generateCode = useMutation(api.channels.link_codes.generateLinkCode);
  const createSlackInstallUrl = useMutation(api.data.integrations.createSlackInstallUrl);
  const [state, setState] = useState<BotSetupState>(() => ({
    status: "loading",
    botLink: sanitizeExternalLinkUrl(integration.botLink),
  }));

  useEffect(() => {
    if (!isExpanded) return;

    let cancelled = false;

    const staticBotLink = sanitizeExternalLinkUrl(integration.botLink);
    setState({
      status: "loading",
      botLink: staticBotLink,
    });

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

      const nextBotLink =
        botLinkResult.status === "fulfilled"
          ? botLinkResult.value
          : integration.provider === "slack"
            ? null
            : staticBotLink;

      if (codeResult.status === "rejected") {
        setState({
          status: "error",
          message: getErrorMessage(
            codeResult.reason,
            "Failed to generate code",
          ),
          botLink: nextBotLink,
        });
        return;
      }

      if (botLinkResult.status === "rejected") {
        setState({
          status: "error",
          message: getErrorMessage(
            botLinkResult.reason,
            "Failed to prepare Slack install URL",
          ),
          botLink: nextBotLink,
        });
        return;
      }

      setState({
        status: "ready",
        code: codeResult.value.code,
        botLink: nextBotLink,
      });
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

  const code = state.status === "ready" ? state.code : null;
  const botLink = state.botLink;
  const error = state.status === "error" ? state.message : null;
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
  const { hasConnectedAccount } = useAuthSessionState();

  let detailContent;
  if (!hasConnectedAccount) {
    detailContent = (
      <p className="connect-instructions">
        Sign in to connect {integration.displayName}.
      </p>
    );
  } else if (isConnected) {
    detailContent = <ConnectedView integration={integration} />;
  } else {
    detailContent = <BotSetupView integration={integration} isExpanded={true} />;
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
