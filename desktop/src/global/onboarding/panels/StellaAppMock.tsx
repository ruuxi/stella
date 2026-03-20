/**
 * Stella App Mock — Shows the default Stella interface during onboarding.
 * Variants: "default" (standard), "modern" (glass UI, blue accents, refined layout).
 */

const css = `
  .sam-root {
    width: 100%;
    height: 100%;
    display: flex;
    font-family: var(--font-family-sans, "Manrope", sans-serif);
    color: var(--foreground);
    background: transparent;
    overflow: hidden;
    user-select: none;
  }
  .sam-root * { box-sizing: border-box; }

  /* ── Sidebar ── */
  .sam-sidebar {
    width: 52px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 14px 0;
    gap: 4px;
    background: color-mix(in oklch, var(--foreground) 2%, transparent);
    border-right: 1px solid color-mix(in oklch, var(--foreground) 6%, transparent);
  }
  .sam-sidebar-icon {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: color-mix(in oklch, var(--foreground) 30%, transparent);
  }
  .sam-sidebar-icon.active {
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    color: color-mix(in oklch, var(--foreground) 55%, transparent);
  }
  .sam-sidebar-divider {
    width: 22px;
    height: 1px;
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
    margin: 4px 0;
  }
  .sam-sidebar-spacer { flex: 1; }

  /* ── Chat area ── */
  .sam-chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .sam-chat-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 20px;
    border-bottom: 1px solid color-mix(in oklch, var(--foreground) 6%, transparent);
    flex-shrink: 0;
  }
  .sam-avatar {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: color-mix(in oklch, var(--foreground) 10%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    color: color-mix(in oklch, var(--foreground) 40%, transparent);
    flex-shrink: 0;
  }
  .sam-chat-name {
    font-size: 13px;
    font-weight: 600;
  }
  .sam-chat-status {
    font-size: 10px;
    opacity: 0.4;
  }
  .sam-messages {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px 24px;
    overflow-y: auto;
    scrollbar-width: none;
  }
  .sam-messages::-webkit-scrollbar { display: none; }

  .sam-msg {
    display: flex;
    max-width: 80%;
  }
  .sam-msg--stella { align-self: flex-start; }
  .sam-msg--user { align-self: flex-end; }

  .sam-bubble {
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 400;
    line-height: 1.5;
    letter-spacing: 0.01em;
  }
  .sam-msg--stella .sam-bubble {
    background: color-mix(in oklch, var(--foreground) 5%, transparent);
    border-radius: 2px 12px 12px 12px;
    opacity: 0.8;
  }
  .sam-msg--user .sam-bubble {
    background: color-mix(in oklch, var(--foreground) 8%, transparent);
    border-radius: 12px 2px 12px 12px;
    opacity: 0.9;
  }

  /* ── Composer ── */
  .sam-composer {
    display: flex;
    align-items: center;
    margin: 0 16px 16px;
    padding: 4px 4px 4px 14px;
    border-radius: 10px;
    border: 1px solid color-mix(in oklch, var(--foreground) 10%, transparent);
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    flex-shrink: 0;
  }
  .sam-composer-placeholder {
    flex: 1;
    font-size: 13px;
    font-weight: 300;
    opacity: 0.35;
  }
  .sam-composer-send {
    width: 28px;
    height: 28px;
    border-radius: 7px;
    border: none;
    background: var(--foreground);
    color: var(--background);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.25;
    cursor: pointer;
    flex-shrink: 0;
  }

  /* ══════════════════════════════════════════
     MODERN VARIANT — glass UI, blue accents
     ══════════════════════════════════════════ */

  /* Sidebar: translucent glass with blue active indicator */
  .sam-root[data-variant="modern"] .sam-sidebar {
    background: color-mix(in oklch, var(--foreground) 2%, transparent);
    backdrop-filter: blur(20px);
    border-right: 1px solid color-mix(in oklch, var(--foreground) 4%, transparent);
  }
  .sam-root[data-variant="modern"] .sam-sidebar-icon.active {
    background: oklch(0.55 0.18 250 / 0.12);
    color: oklch(0.6 0.18 250);
    box-shadow: 0 0 12px oklch(0.55 0.18 250 / 0.1);
  }
  .sam-root[data-variant="modern"] .sam-sidebar-divider {
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
  }

  /* Header: glass, blue status dot */
  .sam-root[data-variant="modern"] .sam-chat-header {
    backdrop-filter: blur(12px);
    border-bottom: 1px solid color-mix(in oklch, var(--foreground) 4%, transparent);
  }
  .sam-root[data-variant="modern"] .sam-avatar {
    background: linear-gradient(135deg, oklch(0.6 0.15 250 / 0.2), oklch(0.55 0.2 280 / 0.15));
    border: 1px solid oklch(0.6 0.15 250 / 0.15);
    color: oklch(0.6 0.18 250);
  }
  .sam-root[data-variant="modern"] .sam-chat-status {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .sam-root[data-variant="modern"] .sam-chat-status::before {
    content: "";
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: oklch(0.7 0.18 150);
    flex-shrink: 0;
  }

  /* Messages: glass bubbles, blue user messages */
  .sam-root[data-variant="modern"] .sam-messages {
    gap: 16px;
    padding: 24px 28px;
  }
  .sam-root[data-variant="modern"] .sam-msg--stella .sam-bubble {
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
    backdrop-filter: blur(16px);
    border: 1px solid color-mix(in oklch, var(--foreground) 5%, transparent);
    border-radius: 4px 18px 18px 18px;
    opacity: 0.85;
    box-shadow: 0 1px 3px color-mix(in oklch, var(--foreground) 2%, transparent);
  }
  .sam-root[data-variant="modern"] .sam-msg--user .sam-bubble {
    background: oklch(0.55 0.16 250 / 0.14);
    backdrop-filter: blur(16px);
    border: 1px solid oklch(0.55 0.16 250 / 0.1);
    border-radius: 18px 4px 18px 18px;
    opacity: 0.95;
    box-shadow: 0 1px 4px oklch(0.55 0.16 250 / 0.08);
  }

  /* Composer: pill-shaped glass with blue send button */
  .sam-root[data-variant="modern"] .sam-composer {
    backdrop-filter: blur(20px);
    background: color-mix(in oklch, var(--foreground) 2%, transparent);
    border: 1px solid color-mix(in oklch, var(--foreground) 6%, transparent);
    border-radius: 20px;
    padding: 5px 5px 5px 16px;
    margin: 0 20px 20px;
    box-shadow: 0 2px 8px color-mix(in oklch, var(--foreground) 3%, transparent);
  }
  .sam-root[data-variant="modern"] .sam-composer-send {
    background: oklch(0.55 0.18 250);
    border-radius: 50%;
    width: 30px;
    height: 30px;
    opacity: 0.9;
    box-shadow: 0 2px 8px oklch(0.55 0.18 250 / 0.3);
  }

  /* Timestamp labels between messages */
  .sam-timestamp {
    display: none;
  }
  .sam-root[data-variant="modern"] .sam-timestamp {
    display: block;
    text-align: center;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.25;
    padding: 4px 0;
  }
`;

const MESSAGES: { role: "stella" | "user" | "timestamp"; text: string }[] = [
  { role: "timestamp", text: "Today, 9:12 AM" },
  { role: "stella", text: "Good morning! You have a clear schedule today." },
  { role: "user", text: "Great, can you check my email?" },
  { role: "stella", text: "You have 3 new emails. One from Alex about the project update, one shipping notification, and a newsletter." },
  { role: "user", text: "Summarize Alex\u2019s email for me" },
  { role: "stella", text: "Alex says the design review is moved to Thursday at 2pm. They want your feedback on the new mockups before then." },
];

export function StellaAppMock({ variant = "default" }: { variant?: "default" | "modern" }) {
  return (
    <>
      <style>{css}</style>
      <div className="sam-root" data-variant={variant}>
        <div className="sam-sidebar">
          <div className="sam-sidebar-icon active">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div className="sam-sidebar-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <path d="M9 22V12h6v10" />
            </svg>
          </div>
          <div className="sam-sidebar-divider" />
          <div className="sam-sidebar-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <path d="M3 9h18M9 21V9" />
            </svg>
          </div>
          <div className="sam-sidebar-spacer" />
          <div className="sam-sidebar-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </div>
        </div>

        <div className="sam-chat">
          <div className="sam-chat-header">
            <div className="sam-avatar">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="10" r="3" />
                <path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662" />
              </svg>
            </div>
            <div>
              <div className="sam-chat-name">Stella</div>
              <div className="sam-chat-status">always here</div>
            </div>
          </div>

          <div className="sam-messages">
            {MESSAGES.map((msg, i) =>
              msg.role === "timestamp" ? (
                <div key={i} className="sam-timestamp">{msg.text}</div>
              ) : (
                <div key={i} className={`sam-msg sam-msg--${msg.role}`}>
                  <span className="sam-bubble">{msg.text}</span>
                </div>
              )
            )}
          </div>

          <div className="sam-composer">
            <span className="sam-composer-placeholder">Ask me anything...</span>
            <button className="sam-composer-send" aria-label="Send">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
