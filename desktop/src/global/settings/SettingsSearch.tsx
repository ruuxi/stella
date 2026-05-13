import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { Search, X } from "lucide-react";

interface SettingsSearchProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}

/**
 * Settings search input. Lives in the settings tab rail directly under
 * the "Settings" title. Filters tabs (count badges + greyed-out empty
 * tabs) and hides non-matching cards in the active tab.
 *
 * Keyboard:
 *   - `/` (when nothing else is focused) jumps focus here.
 *   - `Esc` clears the current query.
 *   - `Enter` is a no-op — filtering is live.
 */
export const SettingsSearch = forwardRef<HTMLInputElement, SettingsSearchProps>(
  function SettingsSearch({ value, onChange, placeholder }, ref) {
    const innerRef = useRef<HTMLInputElement>(null);

    const setRefs = useCallback(
      (node: HTMLInputElement | null) => {
        innerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    useEffect(() => {
      // `/` to focus (skip if a text input/textarea/contenteditable
      // already has focus, so users can still type "/" in those fields).
      const handler = (event: globalThis.KeyboardEvent) => {
        if (event.key !== "/") return;
        const target = event.target as HTMLElement | null;
        if (target) {
          const tag = target.tagName;
          if (
            tag === "INPUT" ||
            tag === "TEXTAREA" ||
            target.isContentEditable
          ) {
            return;
          }
        }
        const input = innerRef.current;
        if (!input) return;
        event.preventDefault();
        input.focus();
        input.select();
      };
      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }, []);

    const handleChange = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => {
        onChange(event.target.value);
      },
      [onChange],
    );

    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape" && value.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          onChange("");
        }
      },
      [onChange, value],
    );

    const handleClear = useCallback(() => {
      onChange("");
      innerRef.current?.focus();
    }, [onChange]);

    return (
      <div
        className="settings-search"
        data-has-value={value.length > 0 ? "true" : "false"}
        role="search"
      >
        <Search
          size={13}
          strokeWidth={1.85}
          className="settings-search-icon"
          aria-hidden
        />
        <input
          ref={setRefs}
          type="search"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? "Search settings"}
          className="settings-search-input"
          aria-label="Search settings"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
        {value.length > 0 ? (
          <button
            type="button"
            className="settings-search-clear"
            onClick={handleClear}
            aria-label="Clear search"
            title="Clear search"
          >
            <X size={12} strokeWidth={2} />
          </button>
        ) : null}
      </div>
    );
  },
);
