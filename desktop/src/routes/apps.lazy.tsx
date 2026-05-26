import { createLazyFileRoute, Outlet } from "@tanstack/react-router";

function AppsLayout() {
  return <Outlet />;
}

export const Route = createLazyFileRoute("/apps")({
  component: AppsLayout,
});
