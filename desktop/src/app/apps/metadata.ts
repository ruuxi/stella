import { CustomLayout } from "@/ui/nav-icons";
import type { AppMetadata } from "../_shared/app-metadata";
import { getLastUserAppRoute } from "./last-user-app-location";

const metadata: AppMetadata = {
  id: "apps",
  label: "Apps",
  icon: CustomLayout,
  route: "/apps",
  slot: "top",
  order: 20,
  // From outside the apps area, return to the app the user was inside
  // (the root shell's keep-alive host may still have it mounted) instead
  // of the library. Clicking Apps while already inside an app keeps the
  // default `/apps` navigation, so the library stays reachable.
  resolveClickRoute: () => getLastUserAppRoute() ?? "/apps",
};

export default metadata;
