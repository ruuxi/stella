import { useState, useEffect, useCallback } from "react";
import { Button } from "@/ui/button";
import "@/global/settings/ConnectionsTab.css";

type AuthState = {
  status: "loading" | "connected" | "disconnected" | "unavailable";
  email?: string;
  name?: string;
};

type ActionState = "idle" | "connecting" | "disconnecting";

function GoogleWorkspaceCard() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [action, setAction] = useState<ActionState>("idle");

  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI?.googleWorkspace;
    if (!api) {
      setAuth({ status: "unavailable" });
      return;
    }
    api.getAuthStatus().then((result) => {
      if (cancelled) return;
      if (result.unavailable) {
        setAuth({ status: "unavailable" });
      } else if (result.connected) {
        setAuth({ status: "connected", email: result.email, name: result.name });
      } else {
        setAuth({ status: "disconnected" });
      }
    }).catch(() => {
      if (!cancelled) setAuth({ status: "disconnected" });
    });
    return () => { cancelled = true; };
  }, []);

  const handleConnect = useCallback(async () => {
    if (action !== "idle") return;
    setAction("connecting");
    try {
      const result = await window.electronAPI?.googleWorkspace.connect();
      if (result?.connected) {
        setAuth({
          status: "connected",
          email: result.email,
          name: result.name,
        });
      } else {
        setAuth({ status: "disconnected" });
      }
    } catch {
      setAuth({ status: "disconnected" });
    } finally {
      setAction("idle");
    }
  }, [action]);

  const handleDisconnect = useCallback(async () => {
    if (action !== "idle") return;
    setAction("disconnecting");
    try {
      const result = await window.electronAPI?.googleWorkspace.disconnect();
      if (result?.ok) {
        setAuth({ status: "disconnected" });
      }
    } catch {
      // keep current state on error
    } finally {
      setAction("idle");
    }
  }, [action]);

  const isConnected = auth.status === "connected";
  const isLoading = auth.status === "loading";
  const isUnavailable = auth.status === "unavailable";

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">Google Workspace</h3>
      <p className="settings-card-desc">
        Connect your Google account so Stella can help with Gmail, Calendar,
        Drive, and Docs.
      </p>

      {isUnavailable ? (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-sublabel">
              Google Workspace isn't available right now.
            </div>
          </div>
        </div>
      ) : (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              <span className="settings-key-status">
                <span
                  className={`settings-key-dot ${isConnected ? "settings-key-dot--active" : "settings-key-dot--inactive"}`}
                />
                {isLoading
                  ? "Checking..."
                  : isConnected
                    ? "Connected"
                    : "Not connected"}
              </span>
            </div>
            {isConnected && auth.email && (
              <div className="settings-row-sublabel">{auth.email}</div>
            )}
          </div>
          <div className="settings-row-control">
            {isConnected ? (
              <Button
                type="button"
                variant="ghost"
                className="settings-btn settings-btn--danger"
                disabled={action === "disconnecting"}
                onClick={handleDisconnect}
              >
                {action === "disconnecting" ? "Disconnecting..." : "Disconnect"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className={`settings-btn ${action !== "connecting" ? "settings-btn--primary" : ""}`}
                disabled={isLoading || action === "connecting"}
                onClick={handleConnect}
              >
                {action === "connecting" ? "Connecting..." : "Connect"}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ConnectionsTab() {
  return (
    <div className="settings-tab-content">
      <GoogleWorkspaceCard />
    </div>
  );
}
