import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { getSnapshot, subscribe } from "@/app/_user/user-apps-registry";

/**
 * The app itself is mounted by `<PersistentUserAppsHost />` in the root
 * shell (outside the router outlet) so it survives navigating away — it is
 * hidden and only torn down after `USER_APP_TEARDOWN_MS` of continuous
 * absence, instead of unmounting instantly with this route. This route only
 * owns the not-found state for unknown slugs.
 */
function UserAppHost() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();
  const apps = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (apps.some((app) => app.slug === slug)) return null;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        padding: "2rem",
        boxSizing: "border-box",
        color: "var(--foreground)",
        fontFamily: "var(--font-family-sans, 'Manrope', sans-serif)",
      }}
    >
      <h1
        style={{
          margin: 0,
          fontFamily:
            "var(--font-family-display, 'Cormorant Garamond', Georgia, serif)",
          fontSize: "clamp(2rem, 4vw, 2.6rem)",
          fontWeight: 300,
          letterSpacing: "-0.04em",
          lineHeight: 1,
        }}
      >
        App not found
      </h1>
      <p
        style={{
          margin: 0,
          color: "color-mix(in oklch, var(--foreground) 70%, transparent)",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        There's no app with the id{" "}
        <code
          style={{
            fontFamily:
              "var(--font-family-mono, 'IBM Plex Mono', monospace)",
            fontSize: "0.95em",
          }}
        >
          {slug}
        </code>
        . It may have been removed.
      </p>
      <button
        type="button"
        onClick={() => void navigate({ to: "/apps" })}
        style={{
          appearance: "none",
          border: "1px solid var(--border)",
          borderRadius: 999,
          padding: "8px 16px",
          background: "color-mix(in oklch, var(--foreground) 5%, transparent)",
          color: "var(--foreground)",
          font: "inherit",
          fontSize: 13,
          cursor: "default",
        }}
      >
        Back to apps
      </button>
    </div>
  );
}

export const Route = createLazyFileRoute("/apps/$slug")({
  component: UserAppHost,
});
