import { useChatRuntime } from "@/context/use-chat-runtime"
import { useUiState } from "@/context/ui-state"
import { displayTabs } from "@/shell/display/tab-store"
import { usePersonalizedCategories } from "./categories"
import "./ideas-tab.css"

/**
 * Display-sidebar tab body for the "Ideas" entry point. Renders the
 * personalized category set grouped vertically with the category label as a
 * section heading. Clicking an option places its prompt into the composer
 * via the shared `onSuggestionClick` from the chat runtime.
 *
 * Lives in `app/home/` because these suggestions are generated from the home
 * onboarding flow; the display-sidebar layer just registers the tab spec with
 * a `() => <IdeasTabContent />` render closure.
 */
export function IdeasTabContent() {
  const { state } = useUiState()
  const { onSuggestionClick } = useChatRuntime()
  const categories = usePersonalizedCategories(state.conversationId)

  const handleClick = (prompt: string) => {
    onSuggestionClick(prompt)
    // Close the panel so the user immediately sees the populated composer.
    displayTabs.setPanelOpen(false)
  }

  return (
    <div className="ideas-tab">
      {categories.map((cat) => (
        <section key={cat.label} className="ideas-tab__group">
          <h3 className="ideas-tab__group-label">{cat.label}</h3>
          <ul className="ideas-tab__options">
            {cat.options.map((opt) => (
              <li key={opt.label}>
                <button
                  type="button"
                  className="ideas-tab__option"
                  onClick={() => handleClick(opt.prompt)}
                >
                  {opt.label}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
