import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePersonalizedCategories } from "@/app/home/categories";
import { useIdeasSeen } from "@/app/home/use-ideas-seen";
import "./home-suggestion-footer.css";

export function HomeSuggestionFooter({
  conversationId,
  onSuggestionClick,
  className,
}: {
  conversationId: string | null;
  onSuggestionClick: (prompt: string) => void;
  className?: string;
}) {
  const { categories, ready: categoriesReady } =
    usePersonalizedCategories(conversationId);
  const { isUnseen, markSeen } = useIdeasSeen(
    conversationId,
    categories,
    categoriesReady,
    true,
  );
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dropupInnerRef = useRef<HTMLDivElement | null>(null);
  const [dropupHeight, setDropupHeight] = useState(0);

  useEffect(() => {
    if (!openLabel) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpenLabel(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenLabel(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [openLabel]);

  useEffect(() => {
    if (!openLabel) return;
    if (!categories.some((category) => category.label === openLabel)) {
      setOpenLabel(null);
    }
  }, [categories, openLabel]);

  const handleTogglePill = useCallback(
    (label: string) => {
      setOpenLabel((current) => {
        const next = current === label ? null : label;
        if (next) markSeen(next);
        return next;
      });
    },
    [markSeen],
  );

  const handleSelectOption = useCallback(
    (prompt: string) => {
      onSuggestionClick(prompt);
      setOpenLabel(null);
    },
    [onSuggestionClick],
  );

  const activeCategory = openLabel
    ? (categories.find((category) => category.label === openLabel) ?? null)
    : null;

  // Drive the dropup container's pixel height off the inner content so
  // opening, closing, and swapping between categories with different
  // option counts all glide between heights via a single CSS transition
  // — no snap on mount, no layout shift on swap. Re-observed on each
  // category change so the next category's natural size is picked up
  // immediately before paint.
  useLayoutEffect(() => {
    if (!openLabel) {
      setDropupHeight(0);
      return;
    }
    const node = dropupInnerRef.current;
    if (!node) return;
    const update = () => {
      if (dropupInnerRef.current) {
        setDropupHeight(dropupInnerRef.current.scrollHeight);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [openLabel]);

  if (categories.length === 0) return null;

  return (
    <div
      className={`home-suggestion-footer${className ? ` ${className}` : ""}`}
      ref={rootRef}
    >
      <div className="home-suggestion-footer__pills" role="tablist">
        {categories.map((category) => {
          const isOpen = category.label === openLabel;
          const showDot = isUnseen(category.label);
          return (
            <button
              key={category.label}
              type="button"
              role="tab"
              aria-selected={isOpen}
              aria-expanded={isOpen}
              className={`home-suggestion-footer__pill${
                isOpen ? " home-suggestion-footer__pill--open" : ""
              }`}
              onClick={() => handleTogglePill(category.label)}
            >
              <span className="home-suggestion-footer__pill-label">
                {category.label}
                {showDot && (
                  <span
                    className="home-suggestion-footer__pill-dot"
                    aria-label="Updated"
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div
        className="home-suggestion-footer__dropdown-grow"
        style={{ height: `${dropupHeight}px` }}
        aria-hidden={!activeCategory}
      >
        <div
          ref={dropupInnerRef}
          className="home-suggestion-footer__dropdown-inner"
        >
          {activeCategory && (
            <ul
              key={activeCategory.label}
              className="home-suggestion-footer__dropdown"
              role="listbox"
              aria-label={`${activeCategory.label} suggestions`}
            >
              {activeCategory.options.map((option) => (
                <li key={option.label} className="home-suggestion-footer__item">
                  <button
                    type="button"
                    className="home-suggestion-footer__option"
                    onClick={() => handleSelectOption(option.prompt)}
                  >
                    {option.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
