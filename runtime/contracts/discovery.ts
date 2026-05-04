import type { DiscoveryCategory as RuntimeDiscoveryCategory } from './index.js'

export type DiscoveryCategory = RuntimeDiscoveryCategory

export type DiscoveryKnowledgeSeedPayload = {
  coreMemory: string;
  formattedSections: Partial<Record<DiscoveryCategory, string>>;
  categoryAnalyses?: Partial<Record<DiscoveryCategory, string>>;
}

export const DISCOVERY_CATEGORIES_KEY = 'stella-discovery-categories'
export const DISCOVERY_CATEGORIES_CHANGED_EVENT = 'stella:discovery-categories-changed'
export const BROWSER_SELECTION_KEY = 'stella-selected-browser'
export const BROWSER_PROFILE_KEY = 'stella-selected-browser-profile'
