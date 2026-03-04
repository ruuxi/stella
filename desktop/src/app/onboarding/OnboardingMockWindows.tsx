import React from "react";

/* ── Mock data for each category ── */

const MOCK_DEV: { label: string; items: string[] }[] = [
  { label: "Projects", items: ["stella", "my-portfolio", "api-service", "dotfiles"] },
  { label: "Tools", items: ["git", "bun", "docker", "node", "python", "cargo"] },
  { label: "Dotfiles", items: [".zshrc", ".nvimrc", ".prettierrc", ".editorconfig"] },
  { label: "Runtimes", items: ["nvm", "pyenv", "rustup"] },
];

const MOCK_APPS: { label: string; items: { name: string; detail: string }[] }[] = [
  {
    label: "Running",
    items: [
      { name: "Spotify", detail: "Active" },
      { name: "Safari", detail: "Active" },
      { name: "Messages", detail: "Active" },
      { name: "Notes", detail: "Active" },
    ],
  },
  {
    label: "Screen Time (7d)",
    items: [
      { name: "Instagram", detail: "4h 12m" },
      { name: "Safari", detail: "3h 45m" },
      { name: "Spotify", detail: "2h 30m" },
      { name: "Netflix", detail: "1h 58m" },
    ],
  },
];

const MOCK_NOTES: { label: string; items: { name: string; detail: string }[] }[] = [
  {
    label: "Notes",
    items: [
      { name: "Personal", detail: "34 notes" },
      { name: "Recipes", detail: "12 notes" },
      { name: "Ideas", detail: "7 notes" },
    ],
  },
  {
    label: "Calendar",
    items: [
      { name: "Work", detail: "156 events" },
      { name: "Personal", detail: "24 events" },
    ],
  },
  {
    label: "Recurring",
    items: [
      { name: "Gym", detail: "3x/week" },
      { name: "Book club", detail: "Monthly" },
    ],
  },
];

const MOCK_BROWSER: { label: string; items: { name: string; detail: string }[] }[] = [
  {
    label: "Most Visited (7d)",
    items: [
      { name: "youtube.com", detail: "112 visits" },
      { name: "instagram.com", detail: "87 visits" },
      { name: "amazon.com", detail: "43 visits" },
      { name: "reddit.com", detail: "38 visits" },
    ],
  },
  {
    label: "Bookmarks",
    items: [
      { name: "Netflix", detail: "netflix.com" },
      { name: "Spotify", detail: "open.spotify.com" },
      { name: "Google Maps", detail: "maps.google.com" },
    ],
  },
];

/* ── Window component ── */

type WindowConfig = {
  id: string;
  title: string;
  content: React.ReactNode;
};

const MockWindow: React.FC<{ title: string; delay: number; children: React.ReactNode }> = ({
  title,
  delay,
  children,
}) => (
  <div className="onboarding-mock-window" style={{ animationDelay: `${delay}s` }}>
    <div className="onboarding-mock-window-titlebar">
      <div className="onboarding-mock-window-dots">
        <span />
        <span />
        <span />
      </div>
      <span className="onboarding-mock-window-title">{title}</span>
    </div>
    <div className="onboarding-mock-window-body">{children}</div>
  </div>
);

/* ── Render helpers ── */

const SimpleList: React.FC<{ sections: { label: string; items: string[] }[] }> = ({ sections }) => (
  <div className="mock-window-sections">
    {sections.map((s) => (
      <div key={s.label} className="mock-window-section">
        <div className="mock-window-section-label">{s.label}</div>
        <div className="mock-window-tags">
          {s.items.map((item) => (
            <span key={item} className="mock-window-tag">{item}</span>
          ))}
        </div>
      </div>
    ))}
  </div>
);

const DetailList: React.FC<{ sections: { label: string; items: { name: string; detail: string }[] }[] }> = ({
  sections,
}) => (
  <div className="mock-window-sections">
    {sections.map((s) => (
      <div key={s.label} className="mock-window-section">
        <div className="mock-window-section-label">{s.label}</div>
        {s.items.map((item) => (
          <div key={item.name} className="mock-window-detail-row">
            <span className="mock-window-detail-name">{item.name}</span>
            <span className="mock-window-detail-value">{item.detail}</span>
          </div>
        ))}
      </div>
    ))}
  </div>
);

/* ── Main component ── */

interface OnboardingMockWindowsProps {
  activeWindowId: string | null;
}

const WINDOW_MAP: Record<string, WindowConfig> = {
  browser: { id: "browser", title: "Browser History", content: <DetailList sections={MOCK_BROWSER} /> },
  apps_system: { id: "apps_system", title: "Apps & System", content: <DetailList sections={MOCK_APPS} /> },
  messages_notes: { id: "messages_notes", title: "Notes & Calendar", content: <DetailList sections={MOCK_NOTES} /> },
  dev_environment: { id: "dev_environment", title: "Coding Setup", content: <SimpleList sections={MOCK_DEV} /> },
};

export const OnboardingMockWindows: React.FC<OnboardingMockWindowsProps> = ({
  activeWindowId,
}) => {
  const active = activeWindowId ? WINDOW_MAP[activeWindowId] : null;

  return (
    <div className="onboarding-mock-windows">
      {active && (
        <MockWindow key={active.id} title={active.title} delay={0}>
          {active.content}
        </MockWindow>
      )}
    </div>
  );
};
