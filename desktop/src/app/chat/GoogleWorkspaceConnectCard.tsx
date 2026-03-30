import { useState, useCallback } from "react";
import { Button } from "@/ui/button";
import "./google-workspace-connect-card.css";

type CardState = "idle" | "connecting" | "connected" | "error";

export function GoogleWorkspaceConnectCard({
  onConnected,
}: {
  onConnected?: () => void;
}) {
  const [state, setState] = useState<CardState>("idle");

  const handleConnect = useCallback(async () => {
    if (state === "connecting" || state === "connected") return;
    setState("connecting");
    try {
      const result = await window.electronAPI?.googleWorkspace.connect();
      if (result?.connected) {
        setState("connected");
        onConnected?.();
      } else {
        setState("error");
      }
    } catch {
      setState("error");
    }
  }, [state, onConnected]);

  if (state === "connected") {
    return (
      <div className="gws-connect-card gws-connect-card--success">
        <svg
          className="gws-connect-icon"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M13.5 4.5L6.5 11.5L2.5 7.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="gws-connect-text">Google account connected</span>
      </div>
    );
  }

  return (
    <div className="gws-connect-card">
      <div className="gws-connect-body">
        <svg
          className="gws-connect-icon"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M14.537 6.545H14V6.5H8v3h3.768A4.002 4.002 0 0 1 4 8a4 4 0 0 1 4-4c1.02 0 1.95.385 2.66 1.013l2.122-2.122A6.963 6.963 0 0 0 8 1a7 7 0 1 0 6.537 5.545Z"
            fill="currentColor"
            opacity="0.6"
          />
        </svg>
        <span className="gws-connect-text">
          Connect your Google account to continue
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        className="gws-connect-btn"
        disabled={state === "connecting"}
        onClick={handleConnect}
      >
        {state === "connecting" ? "Connecting..." : "Connect"}
      </Button>
      {state === "error" && (
        <span className="gws-connect-error">
          Connection failed. Try again.
        </span>
      )}
    </div>
  );
}
