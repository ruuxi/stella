import { CustomLayout } from "@/ui/nav-icons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "apps",
  label: "Apps",
  icon: CustomLayout,
  route: "/apps",
  slot: "top",
  order: 20,
};

export default metadata;
