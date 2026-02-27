import { useRef } from "react";
import type { ViewType } from "@/types/ui";

type PersonalPage = {
  pageId: string;
  panelName: string;
  title: string;
  order: number;
};

interface HeaderTabBarProps {
  activeView: ViewType;
  activeCanvasName?: string | null;
  pages: PersonalPage[];
  onTabSelect: (view: ViewType, page?: PersonalPage) => void;
}

export function HeaderTabBar({ activeView, activeCanvasName, pages, onTabSelect }: HeaderTabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const sortedPages = [...pages].sort((a, b) => a.order - b.order);

  const isPageActive = (page: PersonalPage) =>
    activeView === "app" && activeCanvasName === page.panelName;

  return (
    <div className="htb">
      <button
        className={`htb-tab htb-tab-fixed ${activeView === "home" ? "htb-tab--active" : ""}`}
        onClick={() => onTabSelect("home")}
      >
        Home
      </button>

      <div className="htb-scroll" ref={scrollRef}>
        {sortedPages.map((page) => (
          <button
            key={page.pageId}
            className={`htb-tab ${isPageActive(page) ? "htb-tab--active" : ""}`}
            onClick={() => onTabSelect("app", page)}
            title={page.title}
          >
            <span className="htb-tab-label">{page.title}</span>
          </button>
        ))}
      </div>

      <button
        className={`htb-tab htb-tab-fixed ${activeView === "chat" ? "htb-tab--active" : ""}`}
        onClick={() => onTabSelect("chat")}
      >
        Chat
      </button>
    </div>
  );
}
