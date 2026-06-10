/**
 * Shared "realistic Stella window" used by the onboarding demos
 * (capabilities, shapeshift, summon). One faithful mock — traffic
 * lights, the real sidebar grouping (Home / Store / Social), Cormorant
 * wordmark, pill composer — instead of per-scene approximations, so
 * what users watch in onboarding is what they get in the app.
 *
 * Everything is presentation-only: demos drive visibility through the
 * `use-choreography` cues and pass state down as props.
 */

import type { CSSProperties, ReactNode } from "react";
import { ArrowUp, Check, Mic, Plus } from "@/ui/icons";
import { CustomHouse, CustomStore, CustomUsers } from "@/ui/nav-icons";
import { StellaLogoIcon } from "@/ui/stella-logo-icon";
import "./demo-shell.css";

export type DemoSidebarItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  active?: boolean;
  /** Grows in with a highlight — used when a demo "adds" a feature. */
  fresh?: boolean;
};

export const DEMO_DEFAULT_SIDEBAR: DemoSidebarItem[] = [
  { id: "home", label: "Home", icon: <CustomHouse size={12} />, active: true },
  { id: "store", label: "Store", icon: <CustomStore size={12} /> },
  { id: "social", label: "Social", icon: <CustomUsers size={12} /> },
];

export function DemoShell({
  sidebarItems = DEMO_DEFAULT_SIDEBAR,
  tabs,
  activeTab,
  wordmark = true,
  className,
  style,
  children,
}: {
  sidebarItems?: DemoSidebarItem[];
  /** Optional tab strip in the top bar (the "Give me tabs" morph). */
  tabs?: string[];
  activeTab?: string;
  wordmark?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={`odemo-shell${className ? ` ${className}` : ""}`}
      style={style}
      aria-hidden="true"
    >
      <div className="odemo-shell__topbar">
        <span className="odemo-shell__lights">
          <span />
          <span />
          <span />
        </span>
        {tabs && tabs.length > 0 ? (
          <span className="odemo-shell__tabs">
            {tabs.map((tab) => (
              <span
                key={tab}
                className="odemo-shell__tab"
                data-active={tab === (activeTab ?? tabs[0]) || undefined}
              >
                {tab}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <div className="odemo-shell__body">
        <aside className="odemo-shell__sidebar">
          <nav className="odemo-shell__nav">
            {sidebarItems.map((item) => (
              <span
                key={item.id}
                className="odemo-shell__nav-item"
                data-active={item.active || undefined}
                data-fresh={item.fresh || undefined}
              >
                {item.icon}
                {item.label}
              </span>
            ))}
          </nav>
          <div className="odemo-shell__account">
            <span className="odemo-shell__account-avatar" />
            <span className="odemo-shell__account-name" />
          </div>
        </aside>
        <main className="odemo-shell__main">
          {wordmark ? (
            <div className="odemo-shell__wordmark">Stella</div>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}

/* ── Chat column ─────────────────────────────────────────────────── */

export function DemoChat({ children }: { children: ReactNode }) {
  return <div className="odemo-chat">{children}</div>;
}

export function DemoBubble({
  role,
  visible,
  children,
}: {
  role: "user" | "assistant";
  visible: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="odemo-bubble"
      data-role={role}
      data-visible={visible || undefined}
    >
      {children}
    </div>
  );
}

/**
 * The Claude-style inline working indicator: small Stella mark plus a
 * shimmering status line, exactly where it lives in the real chat.
 */
export function DemoWorking({
  visible,
  label,
}: {
  visible: boolean;
  label: string;
}) {
  return (
    <div className="odemo-working" data-visible={visible || undefined}>
      <StellaLogoIcon size={11} aria-hidden />
      <span className="odemo-working__label">{label}</span>
    </div>
  );
}

/**
 * One agent-activity receipt row — "Opening opentable.com", "Reserved
 * 8:00 PM" — `running` shimmers, `done` settles with a check.
 */
export function DemoWorkCard({
  visible,
  done,
  icon,
  children,
}: {
  visible: boolean;
  done: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="odemo-workcard"
      data-visible={visible || undefined}
      data-done={done || undefined}
    >
      <span className="odemo-workcard__icon">{icon}</span>
      <span className="odemo-workcard__label">{children}</span>
      <span className="odemo-workcard__check">
        <Check size={11} />
      </span>
    </div>
  );
}

/* ── Composer ────────────────────────────────────────────────────── */

export function DemoComposer({
  value,
  typing,
  sending,
  placeholder = "Ask Stella anything...",
}: {
  value: string;
  typing?: boolean;
  /** Briefly highlights the send button as the prompt "goes out". */
  sending?: boolean;
  placeholder?: string;
}) {
  const empty = value.length === 0;
  return (
    <div className="odemo-composer" data-filled={!empty || undefined}>
      <span className="odemo-composer__add">
        <Plus size={12} />
      </span>
      <span className="odemo-composer__input">
        {empty ? (
          <span className="odemo-composer__placeholder">{placeholder}</span>
        ) : (
          <>
            {value}
            {typing ? <span className="odemo-composer__caret" /> : null}
          </>
        )}
      </span>
      {empty ? (
        <span className="odemo-composer__mic">
          <Mic size={12} />
        </span>
      ) : null}
      <span
        className="odemo-composer__send"
        data-sending={sending || undefined}
      >
        <ArrowUp size={12} />
      </span>
    </div>
  );
}
