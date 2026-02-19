import type { Theme } from "@/theme/themes/types";

export type StorePage = "browse" | "detail" | "installed" | "updates";
export type PackageType = "skill" | "canvas" | "theme" | "mod";
export type CategoryTab = "all" | PackageType;

export interface StoreViewProps {
  onBack: () => void;
  onComposePrompt: (text: string) => void;
}

export type StorePackage = {
  _id: string;
  packageId: string;
  name: string;
  author: string;
  description: string;
  type: PackageType;
  version: string;
  tags: string[];
  downloads: number;
  rating?: number;
  icon?: string;
  readme?: string;
  modPayload?: unknown;
  implementation?: string;
};

export type InstalledRecord = {
  packageId: string;
  installedVersion: string;
};

export type StoreUpdatePackage = StorePackage & {
  installedVersion: string;
};

export type SkillPackagePayload = {
  markdown?: string;
  agentTypes?: string[];
  tags?: string[];
};

export type ThemePackagePayload = {
  light?: Theme["light"];
  dark?: Theme["dark"];
};

export type CanvasPackagePayload = {
  workspaceId?: string;
  workspaceName?: string;
  dependencies?: Record<string, string>;
  source?: string;
};

export const CATEGORY_TABS: { label: string; value: CategoryTab }[] = [
  { label: "All", value: "all" },
  { label: "Mods", value: "mod" },
  { label: "Skills", value: "skill" },
  { label: "Mini-apps", value: "canvas" },
  { label: "Themes", value: "theme" },
];

export const TYPE_ICONS: Record<string, string> = {
  skill: "\u2728",
  canvas: "\u{1F3A8}",
  theme: "\u{1F308}",
  mod: "\u2699\uFE0F",
};

export const TYPE_GRADIENTS: Record<string, string> = {
  skill: "linear-gradient(135deg, #ff6b35 0%, #f7c948 100%)",
  canvas: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  theme: "linear-gradient(135deg, #ee5a6f 0%, #f093fb 100%)",
  mod: "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
};

const AUTHOR_COLORS = [
  "#e74c3c",
  "#e67e22",
  "#2ecc71",
  "#1abc9c",
  "#3498db",
  "#9b59b6",
  "#e84393",
  "#6c5ce7",
];

export function getAuthorColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AUTHOR_COLORS[Math.abs(hash) % AUTHOR_COLORS.length];
}
