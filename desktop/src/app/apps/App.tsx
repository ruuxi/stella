import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { dispatchShowHome } from "@/shared/lib/stella-orb-chat";
import "./apps.css";

export function AppsApp() {
  const navigate = useNavigate();

  const handleCreateApp = useCallback(() => {
    void navigate({ to: "/chat" }).then(() => {
      dispatchShowHome();
    });
  }, [navigate]);

  return (
    <div className="apps-screen">
      <button
        type="button"
        className="apps-screen__cta"
        onClick={handleCreateApp}
      >
        Ask Stella to create an app
      </button>
    </div>
  );
}
