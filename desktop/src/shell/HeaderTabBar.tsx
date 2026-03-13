import { useRef } from "react";
import "./header-tab-bar.css";

export type PersonalPage = {
  pageId: string;
  panelName: string;
  title: string;
  order: number;
};

interface HeaderTabBarProps {
  activePanelName?: string | null;
  pages: PersonalPage[];
  onTabSelect: (page: PersonalPage) => void;
}

export function HeaderTabBar({ activePanelName, pages, onTabSelect }: HeaderTabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const sortedPages = [...pages].sort((a, b) => a.order - b.order);

  const isPageActive = (page: PersonalPage) => activePanelName === page.panelName;

  return (
    <div className="htb">
      <div className="htb-scroll" ref={scrollRef}>
        {sortedPages.map((page) => (
          <button
            key={page.pageId}
            className={`htb-tab ${isPageActive(page) ? "htb-tab--active" : ""}`}
            onClick={() => onTabSelect(page)}
            title={page.title}
          >
            <span className="htb-tab-label">{page.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
