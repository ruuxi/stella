import {
  memo,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
  type FormEvent,
} from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/api";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
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
  headline,
  instructions,
  error,
  children,
}: {
  headline: string;
  instructions: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="connect-pair-centered">
      <p className="connect-pair-headline">{headline}</p>
      <p className="connect-pair-sub">{instructions}</p>
      {error ? <div className="connect-error">{error}</div> : null}
      {children}
    </div>
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
    <div className="connect-pair-centered">
      <span className="connect-status">Connected</span>
      <p className="connect-pair-sub">
        Stella is listening on {integration.displayName}. Message her there anytime.
      </p>
      <Button
        variant="ghost"
        onClick={handleDisconnect}
        disabled={disconnecting}
      >
        {disconnecting ? "Disconnecting..." : "Disconnect"}
      </Button>
    </div>
  );
}

const COUNTRY_DIAL_CODES: { code: string; label: string; country: string }[] = [
  { code: "+1", country: "US", label: "United States / Canada (+1)" },
  { code: "+44", country: "GB", label: "United Kingdom (+44)" },
  { code: "+61", country: "AU", label: "Australia (+61)" },
  { code: "+33", country: "FR", label: "France (+33)" },
  { code: "+49", country: "DE", label: "Germany (+49)" },
  { code: "+34", country: "ES", label: "Spain (+34)" },
  { code: "+39", country: "IT", label: "Italy (+39)" },
  { code: "+31", country: "NL", label: "Netherlands (+31)" },
  { code: "+46", country: "SE", label: "Sweden (+46)" },
  { code: "+47", country: "NO", label: "Norway (+47)" },
  { code: "+45", country: "DK", label: "Denmark (+45)" },
  { code: "+41", country: "CH", label: "Switzerland (+41)" },
  { code: "+43", country: "AT", label: "Austria (+43)" },
  { code: "+32", country: "BE", label: "Belgium (+32)" },
  { code: "+351", country: "PT", label: "Portugal (+351)" },
  { code: "+353", country: "IE", label: "Ireland (+353)" },
  { code: "+358", country: "FI", label: "Finland (+358)" },
  { code: "+30", country: "GR", label: "Greece (+30)" },
  { code: "+48", country: "PL", label: "Poland (+48)" },
  { code: "+420", country: "CZ", label: "Czechia (+420)" },
  { code: "+36", country: "HU", label: "Hungary (+36)" },
  { code: "+40", country: "RO", label: "Romania (+40)" },
  { code: "+90", country: "TR", label: "Turkey (+90)" },
  { code: "+972", country: "IL", label: "Israel (+972)" },
  { code: "+971", country: "AE", label: "United Arab Emirates (+971)" },
  { code: "+966", country: "SA", label: "Saudi Arabia (+966)" },
  { code: "+91", country: "IN", label: "India (+91)" },
  { code: "+92", country: "PK", label: "Pakistan (+92)" },
  { code: "+880", country: "BD", label: "Bangladesh (+880)" },
  { code: "+86", country: "CN", label: "China (+86)" },
  { code: "+852", country: "HK", label: "Hong Kong (+852)" },
  { code: "+886", country: "TW", label: "Taiwan (+886)" },
  { code: "+81", country: "JP", label: "Japan (+81)" },
  { code: "+82", country: "KR", label: "South Korea (+82)" },
  { code: "+65", country: "SG", label: "Singapore (+65)" },
  { code: "+60", country: "MY", label: "Malaysia (+60)" },
  { code: "+66", country: "TH", label: "Thailand (+66)" },
  { code: "+84", country: "VN", label: "Vietnam (+84)" },
  { code: "+62", country: "ID", label: "Indonesia (+62)" },
  { code: "+63", country: "PH", label: "Philippines (+63)" },
  { code: "+64", country: "NZ", label: "New Zealand (+64)" },
  { code: "+27", country: "ZA", label: "South Africa (+27)" },
  { code: "+234", country: "NG", label: "Nigeria (+234)" },
  { code: "+254", country: "KE", label: "Kenya (+254)" },
  { code: "+20", country: "EG", label: "Egypt (+20)" },
  { code: "+212", country: "MA", label: "Morocco (+212)" },
  { code: "+52", country: "MX", label: "Mexico (+52)" },
  { code: "+55", country: "BR", label: "Brazil (+55)" },
  { code: "+54", country: "AR", label: "Argentina (+54)" },
  { code: "+56", country: "CL", label: "Chile (+56)" },
  { code: "+57", country: "CO", label: "Colombia (+57)" },
  { code: "+51", country: "PE", label: "Peru (+51)" },
];

function composeE164(dialCode: string, localNumber: string): string {
  const localDigits = localNumber.replace(/\D/g, "");
  return `${dialCode}${localDigits}`;
}

function LinqSetupView({ integration }: { integration: Integration }) {
  const sendSms = useAction(api.channels.linq.sendLinqLinkSms);
  const verifyCode = useMutation(api.channels.link_codes.verifyLinqLinkCode);
  const [dialCode, setDialCode] = useState("+1");
  const [phone, setPhone] = useState("");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fullPhone = composeE164(dialCode, phone);

  const handleSendSms = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!phone.trim() || sending) return;
    setError(null);
    setSending(true);
    try {
      await sendSms({ phoneNumber: fullPhone });
      setStep("code");
    } catch (err) {
      setError(getErrorMessage(err, "Failed to send code. Check the number and try again."));
    } finally {
      setSending(false);
    }
  }, [phone, sending, sendSms, fullPhone]);

  const handleVerify = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || verifying) return;
    setError(null);
    setVerifying(true);
    try {
      const { result } = await verifyCode({
        code: code.trim(),
        phoneNumber: fullPhone,
      });
      if (result === "linked") {
        showToast("Connected! You can now text Stella.");
      } else if (result === "invalid_code") {
        setError("Invalid or expired code. Try sending a new one.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } catch (err) {
      setError(getErrorMessage(err, "Failed to verify code."));
    } finally {
      setVerifying(false);
    }
  }, [code, verifying, verifyCode, fullPhone]);

  return (
    <div className="connect-pair-centered">
      {step === "phone" ? (
        <>
          <p className="connect-pair-headline">Text Stella</p>
          <p className="connect-pair-sub">{integration.instructions}</p>
          {error && <div className="connect-error">{error}</div>}
          <form className="connect-phone-form" onSubmit={handleSendSms}>
            <div className="connect-phone-input-group">
              <Select
                className="connect-phone-dial"
                value={dialCode}
                onValueChange={(value) => setDialCode(value)}
                aria-label="Country code"
                options={COUNTRY_DIAL_CODES.map((c) => ({
                  value: c.code,
                  label: `${c.country} ${c.code}`,
                }))}
              />
              <input
                type="tel"
                className="connect-phone-input"
                placeholder="(555) 123-4567"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoFocus
              />
            </div>
            <Button
              type="submit"
              variant="ghost"
              disabled={!phone.trim() || sending}
            >
              {sending ? "Sending..." : "Send Code"}
            </Button>
          </form>
        </>
      ) : (
        <>
          <p className="connect-pair-headline">Enter your code</p>
          <p className="connect-pair-sub">
            Check your phone — we sent a 6-digit code to {fullPhone}.
          </p>
          {error && <div className="connect-error">{error}</div>}
          <form className="connect-phone-form" onSubmit={handleVerify}>
            <input
              type="text"
              className="connect-code-input"
              placeholder="ABC123"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={6}
              autoFocus
              autoComplete="one-time-code"
            />
            <Button
              type="submit"
              variant="ghost"
              disabled={code.trim().length < 6 || verifying}
            >
              {verifying ? "Verifying..." : "Verify"}
            </Button>
          </form>
          <button
            type="button"
            className="connect-bot-link"
            onClick={() => { setStep("phone"); setCode(""); setError(null); }}
          >
            Use a different number
          </button>
        </>
      )}
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
    <SetupContent
      headline={`Connect ${integration.displayName}`}
      instructions={integration.instructions}
      error={error}
    >
      <div className="connect-pair-code-group">
        {code ? (
          <>
            <span className="connect-pair-code">{code}</span>
            <Button variant="ghost" size="small" onClick={handleCopy}>
              Copy
            </Button>
          </>
        ) : (
          <div className="connect-skeleton connect-skeleton-code" />
        )}
      </div>

      {botLink ? (
        <a
          className="connect-bot-link"
          href={botLink}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open {integration.displayName} &#8599;
        </a>
      ) : null}
    </SetupContent>
  );
}

type IntegrationGridCardProps = {
  integration: Integration;
  isSelected: boolean;
  onClick: () => void;
  disabled?: boolean;
};

function IntegrationGridCardComponent({
  integration,
  isSelected,
  onClick,
  disabled,
}: IntegrationGridCardProps) {
  const isConnected = useIntegrationConnectionStatus(integration.provider);

  return (
    <button
      className={`connect-grid-card${isSelected ? " connect-grid-card-selected" : ""}`}
      onClick={onClick}
      type="button"
      disabled={disabled}
      aria-disabled={disabled || undefined}
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
      <div className="connect-pair-centered">
        <p className="connect-pair-headline">Sign in to get started</p>
        <p className="connect-pair-sub">
          Sign in to your Stella account to connect {integration.displayName}.
        </p>
      </div>
    );
  } else if (isConnected) {
    detailContent = <ConnectedView integration={integration} />;
  } else if (integration.provider === "linq") {
    detailContent = <LinqSetupView integration={integration} />;
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
