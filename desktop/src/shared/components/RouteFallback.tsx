import { Spinner } from "@/ui/spinner";

/**
 * Default `<Suspense>` fallback for lazily-loaded route components.
 *
 * Routes such as `/billing` and `/settings` previously rendered `null` while
 * their chunk fetched, which manifested as a blank panel for ~200–500ms after
 * navigation (longer on a cold cache / hard reload). This shows a centered
 * spinner so the surface acknowledges the click immediately.
 */
export function RouteFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        width: "100%",
        minHeight: 160,
      }}
    >
      <Spinner size="md" />
    </div>
  );
}
