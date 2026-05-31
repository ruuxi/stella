import { CustomUsers } from "@/ui/nav-icons";
import type { AppMetadata } from "../_shared/app-metadata";

const metadata: AppMetadata = {
  id: "social",
  label: "Social",
  icon: CustomUsers,
  route: "/social",
  slot: "top",
  order: 40,
};

export default metadata;
