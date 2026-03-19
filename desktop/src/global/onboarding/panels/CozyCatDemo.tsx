/**
 * Cozy Cat Theme — Single-page cozy dashboard demo for Stella onboarding.
 * Card-based layout centered on warm cream background with dusty rose accents.
 * NO sidebar, NO rigid columns — content flows naturally.
 */

const css = `
  /* ── Reset & Root ── */
  .cozy-root {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
    font-family: var(--font-family-sans, "Satoshi", sans-serif);
    background: oklch(0.97 0.01 80);
    color: oklch(0.35 0.02 280);
    overflow: hidden;
    user-select: none;
  }
  .cozy-root * { box-sizing: border-box; }

  @media (prefers-color-scheme: dark) {
    .cozy-root {
      background: oklch(0.14 0.01 280);
      color: oklch(0.85 0.02 280);
    }
  }

  /* ── Floating paw decorations ── */
  .cozy-paw-float {
    position: absolute;
    opacity: 0.045;
    pointer-events: none;
    animation: cozyFloat 14s ease-in-out infinite;
    z-index: 0;
    color: oklch(0.72 0.12 350);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-paw-float { opacity: 0.04; color: oklch(0.78 0.08 290); }
  }
  @keyframes cozyFloat {
    0%, 100% { transform: translateY(0) rotate(0deg); }
    33% { transform: translateY(-8px) rotate(5deg); }
    66% { transform: translateY(4px) rotate(-3deg); }
  }

  /* ── Sleeping cat decoration ── */
  .cozy-sleeping-cat {
    position: absolute;
    opacity: 0.04;
    pointer-events: none;
    z-index: 0;
    color: oklch(0.72 0.12 350);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-sleeping-cat { opacity: 0.035; color: oklch(0.78 0.08 290); }
  }

  /* ── Top bar ── */
  .cozy-topbar {
    display: flex;
    align-items: center;
    padding: 14px 24px;
    flex-shrink: 0;
    z-index: 2;
    gap: 12px;
  }

  .cozy-avatar {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: linear-gradient(135deg, oklch(0.78 0.08 290), oklch(0.72 0.12 350));
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: 0 2px 10px oklch(0.72 0.12 350 / 0.2);
  }

  .cozy-greeting {
    flex: 1;
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.01em;
  }
  .cozy-greeting-heart {
    color: oklch(0.72 0.12 350);
    margin-left: 4px;
  }

  .cozy-settings-btn {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: 1px solid oklch(0.9 0.02 340);
    background: oklch(0.96 0.015 340 / 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: oklch(0.5 0.04 280);
    flex-shrink: 0;
    padding: 0;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-settings-btn {
      border-color: oklch(0.25 0.015 280);
      background: oklch(0.18 0.015 280 / 0.6);
      color: oklch(0.65 0.02 280);
    }
  }

  /* ── Scrollable content ── */
  .cozy-content {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: none;
    padding: 0 24px 20px;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
  }
  .cozy-content::-webkit-scrollbar { display: none; }

  /* ── Widget grid row ── */
  .cozy-card-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    width: 100%;
    max-width: 600px;
  }

  /* ── Cards ── */
  .cozy-card {
    padding: 14px 16px;
    border-radius: 14px;
    border: 1px solid oklch(0.9 0.02 340);
    background: oklch(0.96 0.015 340);
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: 0 1px 4px oklch(0.72 0.12 350 / 0.04);
    transition: box-shadow 0.2s ease;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-card {
      border-color: oklch(0.25 0.015 280);
      background: oklch(0.18 0.015 280);
      box-shadow: 0 1px 4px oklch(0 0 0 / 0.12);
    }
  }

  .cozy-card-icon {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .cozy-card-icon--rose {
    background: oklch(0.72 0.12 350 / 0.1);
    color: oklch(0.72 0.12 350);
  }
  .cozy-card-icon--lavender {
    background: oklch(0.78 0.08 290 / 0.12);
    color: oklch(0.78 0.08 290);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-card-icon--rose {
      background: oklch(0.72 0.12 350 / 0.15);
    }
    .cozy-card-icon--lavender {
      background: oklch(0.78 0.08 290 / 0.15);
    }
  }

  .cozy-card-label {
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: oklch(0.5 0.03 280);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-card-label { color: oklch(0.6 0.02 280); }
  }

  .cozy-card-value {
    font-size: 18px;
    font-weight: 300;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  .cozy-card-sub {
    font-size: 11px;
    font-weight: 400;
    color: oklch(0.5 0.03 280);
    line-height: 1.35;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-card-sub { color: oklch(0.6 0.02 280); }
  }

  .cozy-card-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* ── Chat card (large, centered) ── */
  .cozy-chat-card {
    width: 100%;
    max-width: 600px;
    padding: 0;
    border-radius: 16px;
    border: 1px solid oklch(0.9 0.02 340);
    background: oklch(0.96 0.015 340);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 2px 12px oklch(0.72 0.12 350 / 0.06);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-chat-card {
      border-color: oklch(0.25 0.015 280);
      background: oklch(0.18 0.015 280);
      box-shadow: 0 2px 12px oklch(0 0 0 / 0.15);
    }
  }

  .cozy-chat-header {
    padding: 12px 16px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: oklch(0.5 0.03 280);
    border-bottom: 1px solid oklch(0.9 0.02 340);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-chat-header {
      color: oklch(0.6 0.02 280);
      border-bottom-color: oklch(0.25 0.015 280);
    }
  }

  .cozy-chat-header-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: oklch(0.72 0.12 350);
    animation: cozyPulse 2.5s ease-in-out infinite;
  }
  @keyframes cozyPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .cozy-messages {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
  }

  .cozy-msg {
    display: flex;
    max-width: 88%;
  }
  .cozy-msg--stella { align-self: flex-start; }
  .cozy-msg--user { align-self: flex-end; }

  .cozy-msg-avatar {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: linear-gradient(135deg, oklch(0.78 0.08 290), oklch(0.72 0.12 350));
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-right: 8px;
    margin-top: 2px;
  }

  .cozy-bubble {
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 400;
    line-height: 1.55;
    letter-spacing: 0.005em;
  }

  .cozy-msg--stella .cozy-bubble {
    background: oklch(0.97 0.01 80);
    border: 1px solid oklch(0.9 0.02 340);
    border-radius: 14px 14px 14px 4px;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-msg--stella .cozy-bubble {
      background: oklch(0.16 0.01 280);
      border-color: oklch(0.25 0.015 280);
    }
  }

  .cozy-msg--user .cozy-bubble {
    background: oklch(0.72 0.12 350 / 0.1);
    border: 1px solid oklch(0.72 0.12 350 / 0.15);
    border-radius: 14px 14px 4px 14px;
    color: oklch(0.35 0.02 280);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-msg--user .cozy-bubble {
      background: oklch(0.72 0.12 350 / 0.12);
      border-color: oklch(0.72 0.12 350 / 0.18);
      color: oklch(0.85 0.02 280);
    }
  }

  .cozy-composer {
    display: flex;
    align-items: center;
    margin: 0 12px 12px;
    padding: 5px 5px 5px 14px;
    border-radius: 20px;
    background: oklch(0.97 0.01 80);
    border: 1px solid oklch(0.9 0.02 340);
    flex-shrink: 0;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-composer {
      background: oklch(0.16 0.01 280);
      border-color: oklch(0.25 0.015 280);
    }
  }

  .cozy-composer-text {
    flex: 1;
    font-size: 12.5px;
    font-weight: 300;
    color: oklch(0.5 0.03 280);
    letter-spacing: 0.02em;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-composer-text { color: oklch(0.55 0.02 280); }
  }

  .cozy-send-btn {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: none;
    background: linear-gradient(135deg, oklch(0.78 0.08 290), oklch(0.72 0.12 350));
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: 0 2px 8px oklch(0.72 0.12 350 / 0.25);
    padding: 0;
  }

  /* ── Progress bar ── */
  .cozy-progress-track {
    height: 4px;
    border-radius: 2px;
    background: oklch(0.9 0.02 340);
    overflow: hidden;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-progress-track { background: oklch(0.25 0.015 280); }
  }
  .cozy-progress-fill {
    height: 100%;
    border-radius: 2px;
    background: linear-gradient(90deg, oklch(0.78 0.08 290), oklch(0.72 0.12 350));
  }

  /* ── Equalizer bars ── */
  .cozy-eq {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 14px;
  }
  .cozy-eq-bar {
    width: 2.5px;
    background: oklch(0.72 0.12 350);
    border-radius: 1px;
    animation: cozyEq 0.75s ease-in-out infinite alternate;
  }
  .cozy-eq-bar:nth-child(1) { height: 5px; animation-delay: 0s; }
  .cozy-eq-bar:nth-child(2) { height: 10px; animation-delay: 0.12s; }
  .cozy-eq-bar:nth-child(3) { height: 6px; animation-delay: 0.24s; }
  .cozy-eq-bar:nth-child(4) { height: 8px; animation-delay: 0.36s; }
  @keyframes cozyEq {
    0% { transform: scaleY(0.35); }
    100% { transform: scaleY(1); }
  }

  /* ── Task items ── */
  .cozy-task {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 2px 0;
  }
  .cozy-task-check {
    width: 14px;
    height: 14px;
    border-radius: 4px;
    border: 1.5px solid oklch(0.9 0.02 340);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background: transparent;
  }
  .cozy-task-check.checked {
    background: oklch(0.72 0.12 350);
    border-color: oklch(0.72 0.12 350);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-task-check { border-color: oklch(0.35 0.015 280); }
    .cozy-task-check.checked {
      background: oklch(0.72 0.12 350);
      border-color: oklch(0.72 0.12 350);
    }
  }
  .cozy-task-text {
    font-size: 11.5px;
    font-weight: 400;
    line-height: 1.3;
  }
  .cozy-task-text.done {
    text-decoration: line-through;
    opacity: 0.4;
  }

  /* ── Mood indicator ── */
  .cozy-mood {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .cozy-mood-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: oklch(0.78 0.08 290);
    box-shadow: 0 0 8px oklch(0.78 0.08 290 / 0.3);
  }
  .cozy-mood-text {
    font-size: 14px;
    font-weight: 300;
    letter-spacing: -0.01em;
  }

  /* ── Fish bone divider ── */
  .cozy-fishbone {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    opacity: 0.1;
    padding: 4px 0;
    color: oklch(0.72 0.12 350);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-fishbone { opacity: 0.08; color: oklch(0.78 0.08 290); }
  }

  /* ── Whisker decoration on cards ── */
  .cozy-whiskers {
    position: absolute;
    top: 8px;
    right: 10px;
    opacity: 0.06;
    pointer-events: none;
    color: oklch(0.72 0.12 350);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-whiskers { opacity: 0.05; color: oklch(0.78 0.08 290); }
  }

  /* ── Paw trail footer ── */
  .cozy-paw-trail {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px 0 4px;
    opacity: 0.08;
    color: oklch(0.72 0.12 350);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-paw-trail { opacity: 0.06; color: oklch(0.78 0.08 290); }
  }
  .cozy-paw-trail-dot {
    width: 2px;
    height: 2px;
    border-radius: 50%;
    background: currentColor;
  }

  /* ── Cloud SVG ── */
  .cozy-cloud {
    color: oklch(0.5 0.03 280);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-cloud { color: oklch(0.6 0.02 280); }
  }
`;

/* ── Inline SVG Components ── */

const SleepingCat = ({ size, style }: { size: number; style?: React.CSSProperties }) => (
  <div className="cozy-sleeping-cat" style={{ ...style, width: size, height: size }}>
    <svg viewBox="0 0 64 40" width={size} height={size * 0.625} fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      {/* Curled up sleeping cat silhouette */}
      <path d="M48 28c0 6-8 10-18 10S10 34 10 28s4-10 10-10c2 0 3-1 4-3l2-4c1-2 3-3 5-3h2c2 0 4 1 5 3l2 4c1 2 2 3 4 3 6 0 4 4 4 10z" />
      {/* Ears */}
      <path d="M22 12l-4-8c-.5-1 .5-2 1.5-1.5L24 6l-2 6z" />
      <path d="M38 12l4-8c.5-1-.5-2-1.5-1.5L36 6l2 6z" />
      {/* Tail curving around */}
      <path d="M46 30c4-1 8-2 10-5s2-6 0-8-5-2-7 0" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  </div>
);

const PawPrint = ({ size }: { size: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="12" cy="16.5" rx="4" ry="3.2" />
    <circle cx="7.2" cy="10.5" r="2" />
    <circle cx="16.8" cy="10.5" r="2" />
    <circle cx="9.5" cy="6.5" r="1.7" />
    <circle cx="14.5" cy="6.5" r="1.7" />
  </svg>
);

const PawDecoration = ({ size, style }: { size: number; style: React.CSSProperties }) => (
  <div className="cozy-paw-float" style={{ ...style, width: size, height: size }}>
    <PawPrint size={size} />
  </div>
);

const CatAvatarSVG = () => (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="white" xmlns="http://www.w3.org/2000/svg">
    {/* Simplified cat face */}
    <path d="M4 13c0 4.4 3.6 8 8 8s8-3.6 8-8c0-3-1.6-5.6-4-7V3l-2.5 3h-3L8 3v3c-2.4 1.4-4 4-4 7z" />
    <circle cx="9.5" cy="12" r="1" fill="oklch(0.72 0.12 350)" />
    <circle cx="14.5" cy="12" r="1" fill="oklch(0.72 0.12 350)" />
    <ellipse cx="12" cy="14.5" rx="1" ry="0.6" fill="oklch(0.72 0.12 350)" />
  </svg>
);

const FishBone = () => (
  <svg viewBox="0 0 48 12" width={48} height={12} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg">
    {/* Spine */}
    <line x1="8" y1="6" x2="40" y2="6" />
    {/* Head */}
    <circle cx="6" cy="6" r="3" />
    {/* Tail */}
    <path d="M40 6l4-3M40 6l4 3" />
    {/* Bones */}
    <path d="M14 6l-2-3M14 6l-2 3" />
    <path d="M20 6l-2-3M20 6l-2 3" />
    <path d="M26 6l2-3M26 6l2 3" />
    <path d="M32 6l2-3M32 6l2 3" />
  </svg>
);

const WhiskerDecoration = () => (
  <svg viewBox="0 0 32 20" width={32} height={20} fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 10c-6 0-12-2-15-4" />
    <path d="M16 10c-6 1-13 0-15 0" />
    <path d="M16 10c-5 2-11 4-14 5" />
    <path d="M16 10c6 0 12-2 15-4" />
    <path d="M16 10c6 1 13 0 15 0" />
    <path d="M16 10c5 2 11 4 14 5" />
  </svg>
);

const CloudSVG = () => (
  <svg viewBox="0 0 24 16" width={20} height={14} fill="currentColor" className="cozy-cloud" xmlns="http://www.w3.org/2000/svg">
    <path d="M19.5 10.5a4 4 0 0 0-3.8-5.4 5.5 5.5 0 0 0-10.4 1.2A3.5 3.5 0 0 0 5.5 13h13a3 3 0 0 0 1-5.5z" opacity="0.35" />
  </svg>
);

export function CozyCatDemo() {
  return (
    <>
      <style>{css}</style>
      <div className="cozy-root">

        {/* ── Floating paw decorations ── */}
        <PawDecoration size={24} style={{ top: "8%", left: "6%", animationDelay: "0s", transform: "rotate(-15deg)" }} />
        <PawDecoration size={18} style={{ top: "22%", right: "8%", animationDelay: "-3s", transform: "rotate(20deg)" }} />
        <PawDecoration size={20} style={{ bottom: "25%", left: "4%", animationDelay: "-7s", transform: "rotate(-25deg)" }} />
        <PawDecoration size={16} style={{ bottom: "12%", right: "6%", animationDelay: "-10s", transform: "rotate(10deg)" }} />

        {/* ── Sleeping cat silhouette (background decoration) ── */}
        <SleepingCat size={120} style={{ bottom: "3%", right: "4%", transform: "rotate(-5deg)" }} />

        {/* ── Slim top bar ── */}
        <div className="cozy-topbar">
          <div className="cozy-avatar">
            <CatAvatarSVG />
          </div>
          <div className="cozy-greeting">
            Good afternoon
            <span className="cozy-greeting-heart"> &#9825;</span>
          </div>
          <button className="cozy-settings-btn" aria-label="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>

        {/* ── Main scrollable content ── */}
        <div className="cozy-content">

          {/* ── Top widget row ── */}
          <div className="cozy-card-row">
            {/* Weather card */}
            <div className="cozy-card">
              <div className="cozy-card-top">
                <div className="cozy-card-icon cozy-card-icon--lavender">
                  <CloudSVG />
                </div>
                <span className="cozy-card-label">Weather</span>
              </div>
              <div className="cozy-card-value">68&#176;</div>
              <div className="cozy-card-sub">Cloudy &mdash; cozy day</div>
            </div>

            {/* Reading card */}
            <div className="cozy-card" style={{ position: "relative", overflow: "hidden" }}>
              <div className="cozy-whiskers">
                <WhiskerDecoration />
              </div>
              <div className="cozy-card-top">
                <div className="cozy-card-icon cozy-card-icon--rose">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                </div>
                <span className="cozy-card-label">Reading</span>
              </div>
              <div style={{ fontSize: "12px", fontWeight: 400, lineHeight: 1.3 }}>The Night Circus</div>
              <div className="cozy-progress-track">
                <div className="cozy-progress-fill" style={{ width: "34%" }} />
              </div>
              <div className="cozy-card-sub">34% &middot; Ch. 12</div>
            </div>

            {/* Music card */}
            <div className="cozy-card">
              <div className="cozy-card-top">
                <div className="cozy-card-icon cozy-card-icon--rose">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                </div>
                <span className="cozy-card-label">Music</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <div className="cozy-eq">
                  <span className="cozy-eq-bar" />
                  <span className="cozy-eq-bar" />
                  <span className="cozy-eq-bar" />
                  <span className="cozy-eq-bar" />
                </div>
                <span style={{ fontSize: "12px", fontWeight: 400 }}>Rainy Jazz</span>
              </div>
            </div>
          </div>

          {/* ── Fish bone divider ── */}
          <div className="cozy-fishbone">
            <FishBone />
          </div>

          {/* ── Chat card (central, largest element) ── */}
          <div className="cozy-chat-card">
            <div className="cozy-chat-header">
              <span className="cozy-chat-header-dot" />
              Chat with Stella
            </div>

            <div className="cozy-messages">
              {/* Stella message 1 */}
              <div className="cozy-msg cozy-msg--stella">
                <div className="cozy-msg-avatar">
                  <svg viewBox="0 0 24 24" width={11} height={11} fill="white" xmlns="http://www.w3.org/2000/svg">
                    <path d="M4 13c0 4.4 3.6 8 8 8s8-3.6 8-8c0-3-1.6-5.6-4-7V3l-2.5 3h-3L8 3v3c-2.4 1.4-4 4-4 7z" />
                  </svg>
                </div>
                <span className="cozy-bubble">Good afternoon! Your schedule is clear &mdash; perfect day to curl up with that book you mentioned.</span>
              </div>

              {/* User message */}
              <div className="cozy-msg cozy-msg--user">
                <span className="cozy-bubble">Sounds great. Any recommendations?</span>
              </div>

              {/* Stella message 2 */}
              <div className="cozy-msg cozy-msg--stella">
                <div className="cozy-msg-avatar">
                  <svg viewBox="0 0 24 24" width={11} height={11} fill="white" xmlns="http://www.w3.org/2000/svg">
                    <path d="M4 13c0 4.4 3.6 8 8 8s8-3.6 8-8c0-3-1.6-5.6-4-7V3l-2.5 3h-3L8 3v3c-2.4 1.4-4 4-4 7z" />
                  </svg>
                </div>
                <span className="cozy-bubble">Based on your reading history, I think you'd love <em>The Night Circus</em>. Want me to find it?</span>
              </div>
            </div>

            <div className="cozy-composer">
              <span className="cozy-composer-text">Say something...</span>
              <button className="cozy-send-btn" aria-label="Send">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </div>

          {/* ── Fish bone divider ── */}
          <div className="cozy-fishbone">
            <FishBone />
          </div>

          {/* ── Bottom widget row ── */}
          <div className="cozy-card-row">
            {/* Tasks card */}
            <div className="cozy-card">
              <div className="cozy-card-top">
                <div className="cozy-card-icon cozy-card-icon--rose">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 11l3 3L22 4" />
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                  </svg>
                </div>
                <span className="cozy-card-label">Tasks</span>
              </div>
              <div className="cozy-task">
                <div className="cozy-task-check checked">
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                </div>
                <span className="cozy-task-text done">Water the plants</span>
              </div>
              <div className="cozy-task">
                <div className="cozy-task-check checked">
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                </div>
                <span className="cozy-task-text done">Call mom</span>
              </div>
              <div className="cozy-task">
                <div className="cozy-task-check" />
                <span className="cozy-task-text">Finish chapter 12</span>
              </div>
            </div>

            {/* Mood card */}
            <div className="cozy-card" style={{ position: "relative", overflow: "hidden" }}>
              <div className="cozy-whiskers">
                <WhiskerDecoration />
              </div>
              <div className="cozy-card-top">
                <div className="cozy-card-icon cozy-card-icon--lavender">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                    <line x1="9" y1="9" x2="9.01" y2="9" />
                    <line x1="15" y1="9" x2="15.01" y2="9" />
                  </svg>
                </div>
                <span className="cozy-card-label">Mood</span>
              </div>
              <div className="cozy-mood">
                <span className="cozy-mood-dot" />
                <span className="cozy-mood-text">Relaxed</span>
              </div>
              <div className="cozy-card-sub">Peaceful afternoon</div>
            </div>

            {/* Cozy Tips card */}
            <div className="cozy-card">
              <div className="cozy-card-top">
                <div className="cozy-card-icon cozy-card-icon--lavender">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a7 7 0 0 0-7 7c0 3 2 5 4 6.5V18h6v-2.5c2-1.5 4-3.5 4-6.5a7 7 0 0 0-7-7z" />
                    <line x1="9" y1="21" x2="15" y2="21" />
                  </svg>
                </div>
                <span className="cozy-card-label">Cozy Tip</span>
              </div>
              <div style={{ fontSize: "12px", fontWeight: 400, lineHeight: 1.45, fontStyle: "italic" }}>
                Try dimming the lights and putting on rain sounds while you read.
              </div>
            </div>
          </div>

          {/* ── Paw trail footer ── */}
          <div className="cozy-paw-trail">
            <PawPrint size={10} />
            <span className="cozy-paw-trail-dot" />
            <span className="cozy-paw-trail-dot" />
            <span className="cozy-paw-trail-dot" />
            <PawPrint size={10} />
            <span className="cozy-paw-trail-dot" />
            <span className="cozy-paw-trail-dot" />
            <span className="cozy-paw-trail-dot" />
            <PawPrint size={10} />
          </div>

        </div>
      </div>
    </>
  );
}
