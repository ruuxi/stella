import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { RouteFallback } from "@/shared/components/RouteFallback";

const CreatorPage = lazy(() =>
  import("@/global/store/CreatorPage").then((m) => ({
    default: m.CreatorPage,
  })),
);

function CreatorRouteComponent() {
  const { handle } = Route.useParams();
  return (
    <Suspense fallback={<RouteFallback />}>
      <CreatorPage handle={handle} />
    </Suspense>
  );
}

export const Route = createFileRoute("/c/$handle")({
  component: CreatorRouteComponent,
});
