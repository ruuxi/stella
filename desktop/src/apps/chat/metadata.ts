import { dispatchShowHome } from "@/shared/lib/stella-orb-chat";
import { CustomHouse } from "@/shell/sidebar/SidebarIcons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "chat",
  label: "Home",
  icon: CustomHouse,
  route: "/chat",
  slot: "top",
  order: 10,
  onActiveClick: dispatchShowHome,
};

export default metadata;
