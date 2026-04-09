import { memo, useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_CATEGORIES, type SuggestionCategory } from "@/app/home/HomeContent";
import "./chat-suggestions.css";

type ChatSuggestionsProps = {
  categories?: SuggestionCategory[];
  onSelect: (prompt: string) => void;
  variant?: "full" | "mini";
};

export const ChatSuggestions = memo(function ChatSuggestions({
  categories = DEFAULT_CATEGORIES,
  onSelect,
  variant = "full",
}: ChatSuggestionsProps) {
  const [open, setOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      if (prev) setActiveCategory(null);
      return !prev;
    });
  }, []);

  const handleSelect = useCallback(
    (prompt: string) => {
      onSelect(prompt);
      setOpen(false);
      setActiveCategory(null);
    },
    [onSelect],
  );

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setActiveCategory(null);
      }
    };
    document.addEventListener("pointerdown", onClickOutside);
    return () => document.removeEventListener("pointerdown", onClickOutside);
  }, [open]);

  const visibleOptions = activeCategory
    ? categories.find((c) => c.label === activeCategory)?.options ?? []
    : [];

  return (
    <div className="chat-suggestions" ref={rootRef}>
      <button
        className={`chat-suggestions-trigger${open ? " chat-suggestions-trigger--active" : ""}${variant === "mini" ? " chat-suggestions-trigger--mini" : ""}`}
        type="button"
        onClick={toggle}
        aria-label="Suggestions"
        aria-expanded={open}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
          <path d="M9 18h6" />
          <path d="M10 22h4" />
        </svg>
      </button>
      {open && (
        <div className="chat-suggestions-menu">
          {activeCategory === null ? (
            <div className="chat-suggestions-categories">
              {categories.map((cat) => (
                <button
                  key={cat.label}
                  className="chat-suggestions-category"
                  type="button"
                  onClick={() => setActiveCategory(cat.label)}
                >
                  {cat.label}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
              ))}
            </div>
          ) : (
            <div className="chat-suggestions-options">
              <button
                className="chat-suggestions-back"
                type="button"
                onClick={() => setActiveCategory(null)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5" />
                  <path d="M12 19l-7-7 7-7" />
                </svg>
                {activeCategory}
              </button>
              {visibleOptions.map((opt) => (
                <button
                  key={opt.label}
                  className="chat-suggestions-option"
                  type="button"
                  onClick={() => handleSelect(opt.prompt)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
