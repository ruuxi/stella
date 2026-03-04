import type { StorePage } from "../constants";

interface StoreHeaderProps {
  page: StorePage;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onPageChange: (p: StorePage) => void;
}

export function StoreHeader({
  page,
  searchQuery,
  onSearchChange,
  onPageChange,
}: StoreHeaderProps) {
  return (
    <div className="store-header">
      <div className="store-header-tabs">
        <button
          type="button"
          className={`store-header-tab${page === "browse" ? " store-header-tab--active" : ""}`}
          onClick={() => onPageChange("browse")}
        >
          Browse
        </button>
        <button
          type="button"
          className={`store-header-tab${page === "installed" ? " store-header-tab--active" : ""}`}
          onClick={() => onPageChange("installed")}
        >
          Installed
        </button>
        <button
          type="button"
          className={`store-header-tab${page === "updates" ? " store-header-tab--active" : ""}`}
          onClick={() => onPageChange("updates")}
        >
          Updates
        </button>
      </div>
      <div className="store-header-search">
        <svg
          className="store-header-search-icon"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          placeholder="Search packages..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
    </div>
  );
}
