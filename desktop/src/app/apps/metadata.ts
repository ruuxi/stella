import { CustomLayout } from "@/ui/nav-icons";
import type { AppMetadata } from "../_shared/app-metadata";

// The full-window bar omits this entry (`ShellTopBarFull`): there the Apps
// sidebar section is the way in, and a nav entry would compete with it for the
// same job. It stays registered for the window types that have no panel.
const metadata: AppMetadata = {
  id: "apps",
  label: "Apps",
  icon: CustomLayout,
  route: "/apps",
  slot: "top",
  order: 20,
};

export default metadata;
