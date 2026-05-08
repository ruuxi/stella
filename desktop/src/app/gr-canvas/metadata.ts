import { CustomLayout } from "@/shell/sidebar/SidebarIcons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "gr-canvas",
  label: "GR Canvas",
  icon: CustomLayout,
  route: "/gr-canvas",
  slot: "top",
  order: 55,
};

export default metadata;
