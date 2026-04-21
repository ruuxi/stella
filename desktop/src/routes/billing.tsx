import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const BillingScreen = lazy(() =>
  import("@/global/billing/BillingScreen").then((m) => ({
    default: m.BillingScreen,
  })),
);

function BillingRouteComponent() {
  return (
    <Suspense fallback={null}>
      <BillingScreen />
    </Suspense>
  );
}

export const Route = createFileRoute("/billing")({
  component: BillingRouteComponent,
});
