import { createLazyFileRoute } from "@tanstack/react-router";
import { BillingScreen } from "@/global/billing/BillingScreen";

export const Route = createLazyFileRoute("/billing")({
  component: BillingScreen,
});
