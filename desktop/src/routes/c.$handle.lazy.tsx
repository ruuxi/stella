import { createLazyFileRoute } from "@tanstack/react-router";
import { CreatorPage } from "@/global/store/CreatorPage";

function CreatorRouteComponent() {
  const { handle } = Route.useParams();
  return <CreatorPage username={handle} />;
}

export const Route = createLazyFileRoute("/c/$handle")({
  component: CreatorRouteComponent,
});
