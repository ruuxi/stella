import { CustomLayout } from "@/shell/sidebar/SidebarIcons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "demo",
  label: "Demo",
  icon: CustomLayout,
  route: "/demo",
  slot: "top",
  order: 40,
};

export default metadata;
