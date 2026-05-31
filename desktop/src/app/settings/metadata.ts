import { CustomSettings } from "@/ui/nav-icons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "settings",
  label: "Settings",
  icon: CustomSettings,
  route: "/settings",
  slot: "bottom",
  order: 40,
};

export default metadata;
