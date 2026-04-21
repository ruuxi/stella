import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { RouteFallback } from "@/shared/components/RouteFallback";

const BillingScreen = lazy(() =>
  import("@/global/billing/BillingScreen").then((m) => ({
    default: m.BillingScreen,
  })),
);

function BillingRouteComponent() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <BillingScreen />
    </Suspense>
  );
}

export const Route = createFileRoute("/billing")({
  component: BillingRouteComponent,
});
