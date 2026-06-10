import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useMemo } from "react";
import { LoaderCircle } from "@/ui/icons";
import { getUserApp } from "@/app/_user/user-apps-registry";

function UserAppHost() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();

  const Component = useMemo(() => {
    const entry = getUserApp(slug);
    if (!entry) return null;
    return lazy(() =>
      entry.load().then((mod) => ({ default: mod.default })),
    );
  }, [slug]);

  if (!Component) {
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
            fontFamily: "var(--font-family-sans, 'Manrope', sans-serif)",
            fontSize: "clamp(1.5rem, 3vw, 2rem)",
            fontWeight: 600,
            letterSpacing: "-0.02em",
            lineHeight: 1.1,
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

  return (
    <Suspense
      fallback={
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <LoaderCircle
            className="stella-loader-circle"
            size={18}
            strokeWidth={2}
            aria-hidden="true"
          />
        </div>
      }
    >
      <Component />
    </Suspense>
  );
}

export const Route = createLazyFileRoute("/apps/$slug")({
  component: UserAppHost,
});
