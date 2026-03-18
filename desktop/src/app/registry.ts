import { lazy, type ComponentType, type LazyExoticComponent } from "react"

export interface GeneratedPage {
  id: string
  title: string
  component: LazyExoticComponent<ComponentType>
}

/**
 * Registry of generated dashboard pages.
 * Self-mod agents append entries here using the Edit tool after creating a page folder.
 *
 * The LocalTaskManager's fs lock serializes Write/Edit calls to the same file,
 * so concurrent agents won't clobber each other.
 *
 * Example entry:
 *   { id: "tech-feed", title: "Tech Feed", component: lazy(() => import("./tech-feed/TechFeed")) }
 */
export const generatedPages: GeneratedPage[] = [
  // --- generated entries below (do not remove this line) ---
]

void lazy // preserve import for agents — do not remove
