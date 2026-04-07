/**
 * Cozy Cat Theme — A black & white cat-obsessed dashboard demo for Stella onboarding.
 * High contrast palette with prominent animated cat illustrations and cat-themed content.
 */

import React from 'react';

const css = `
  .cozy-root {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
    font-family: var(--font-family-sans, "Manrope", sans-serif);
    background: #f8f9fa; /* Very light gray, almost white */
    color: #1a1a1a; /* Almost black */
    overflow: hidden;
    user-select: none;
    --cat-eye-color: #fff;
    --cat-nose-color: #333;
    --cat-line-color: #f8f9fa;
  }
  .cozy-root * { box-sizing: border-box; }

  @media (prefers-color-scheme: dark) {
    .cozy-root {
      background: #121212; /* Very dark gray, almost black */
      color: #f0f0f0; /* Off-white */
      --cat-eye-color: #121212;
      --cat-nose-color: #ccc;
      --cat-line-color: #121212;
    }
  }

  /* ── Cat animations ── */
  @keyframes catEarTwitchLeft {
    0%, 90%, 100% { transform: rotate(0deg); }
    92% { transform: rotate(-15deg); }
    94% { transform: rotate(5deg); }
    96% { transform: rotate(-10deg); }
  }
  @keyframes catEarTwitchRight {
    0%, 80%, 100% { transform: rotate(0deg); }
    82% { transform: rotate(15deg); }
    84% { transform: rotate(-5deg); }
    86% { transform: rotate(10deg); }
  }
  @keyframes catEyeBlink {
    0%, 94%, 100% { transform: scaleY(1); }
    97% { transform: scaleY(0.1); }
  }
  @keyframes catWhiskerTwitch {
    0%, 85%, 100% { transform: translateY(0) rotate(0deg); }
    88% { transform: translateY(1px) rotate(2deg); }
    92% { transform: translateY(-1px) rotate(-2deg); }
  }
  @keyframes catBreathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.02) translateY(-2px); }
  }
  @keyframes catTailWag {
    0%, 100% { transform: rotate(0deg); }
    50% { transform: rotate(8deg); }
  }
  @keyframes catTailCurl {
    0%, 100% { transform: rotate(0deg); }
    50% { transform: rotate(-15deg); }
  }
  @keyframes catZzz {
    0% { transform: translate(0, 0) scale(0.5); opacity: 0; }
    30% { opacity: 1; }
    70% { opacity: 1; }
    100% { transform: translate(-10px, -20px) scale(1.2); opacity: 0; }
  }
  @keyframes pawWalk {
    0%, 100% { opacity: 0.15; transform: scale(0.9); }
    50% { opacity: 0.6; transform: scale(1.1); color: #333; }
  }
  @media (prefers-color-scheme: dark) {
     @keyframes pawWalk {
      0%, 100% { opacity: 0.15; transform: scale(0.9); }
      50% { opacity: 0.6; transform: scale(1.1); color: #ccc; }
    }
  }
  @keyframes fishWiggle {
    0%, 100% { transform: rotate(0deg); }
    25% { transform: rotate(5deg); }
    75% { transform: rotate(-5deg); }
  }
  @keyframes catBounce {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4px); }
  }

  /* ── Applied Animations ── */
  .cat-ear-left { transform-origin: 20px 50px; animation: catEarTwitchLeft 7s infinite; }
  .cat-ear-right { transform-origin: 80px 50px; animation: catEarTwitchRight 6s infinite 1s; }
  .cat-eyes { transform-origin: center 55px; animation: catEyeBlink 5s infinite; }
  .cat-whiskers { transform-origin: 50px 65px; animation: catWhiskerTwitch 4s infinite; }
  
  .cat-body-breathe { transform-origin: center; animation: catBreathe 4s ease-in-out infinite; }
  .cat-tail-curl { transform-origin: 150px 85px; animation: catTailCurl 6s ease-in-out infinite; }
  .cat-zzz-1 { animation: catZzz 3s infinite 0s; }
  .cat-zzz-2 { animation: catZzz 3s infinite 1s; }
  .cat-zzz-3 { animation: catZzz 3s infinite 2s; }
  
  .fish-bone-wiggle { transform-origin: center; animation: fishWiggle 3s ease-in-out infinite; }

  /* ── Big sleeping cat watermark ── */
  .cozy-cat-watermark {
    position: absolute;
    bottom: -10px;
    right: -20px;
    opacity: 0.05;
    pointer-events: none;
    z-index: 0;
    color: #000;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-cat-watermark { opacity: 0.04; color: #fff; }
  }

  /* ── Floating paw decorations ── */
  .cozy-paw-float {
    position: absolute;
    pointer-events: none;
    animation: cozyFloat 15s ease-in-out infinite;
    z-index: 0;
    color: #000;
    opacity: 0.03;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-paw-float { opacity: 0.03; color: #fff; }
  }
  @keyframes cozyFloat {
    0%, 100% { transform: translateY(0) rotate(0deg); }
    33% { transform: translateY(-15px) rotate(10deg); }
    66% { transform: translateY(10px) rotate(-8deg); }
  }

  /* ── Top bar ── */
  .cozy-topbar {
    display: flex;
    align-items: center;
    padding: 16px 24px;
    flex-shrink: 0;
    z-index: 2;
    gap: 12px;
  }

  .cozy-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: #000;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: catBounce 5s ease-in-out infinite;
    border: 2px solid #fff;
  }
  @media (prefers-color-scheme: dark) {
     .cozy-avatar {
       background: #fff;
       color: #000;
       border: 2px solid #333;
       box-shadow: 0 4px 12px rgba(255,255,255,0.1);
     }
  }

  .cozy-greeting {
    flex: 1;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .cozy-greeting-paw {
    display: inline-block;
    opacity: 0.8;
    margin-left: 6px;
    animation: catTailWag 3s infinite ease-in-out;
    transform-origin: bottom center;
  }

  .cozy-settings-btn {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: 1px solid #e0e0e0;
    background: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: #333;
    flex-shrink: 0;
    padding: 0;
    transition: all 0.2s ease;
    box-shadow: 0 2px 5px rgba(0,0,0,0.05);
  }
  .cozy-settings-btn:hover {
    background: #f0f0f0;
    transform: rotate(15deg);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-settings-btn {
      border-color: #333;
      background: #222;
      color: #ccc;
    }
    .cozy-settings-btn:hover {
      background: #2a2a2a;
    }
  }

  /* ── Scrollable content ── */
  .cozy-content {
    flex: 1;
    overflow-y: auto;
    scrollbar-width: none;
    padding: 0 24px 24px;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }
  .cozy-content::-webkit-scrollbar { display: none; }

  /* ── Cat banner ── */
  .cozy-cat-banner {
    width: 100%;
    max-width: 600px;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px 20px;
    border-radius: 16px;
    background: #000;
    color: #fff;
    box-shadow: 0 8px 20px rgba(0,0,0,0.15);
    transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    border: 1px solid #333;
  }
  .cozy-cat-banner:hover {
    transform: translateY(-4px) scale(1.01);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-cat-banner {
      background: #fff;
      color: #000;
      border: 1px solid #e0e0e0;
      box-shadow: 0 8px 20px rgba(255,255,255,0.1);
    }
  }
  .cozy-cat-banner-illustration {
    flex-shrink: 0;
    color: inherit;
  }
  .cozy-cat-banner-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cozy-cat-banner-title {
    font-size: 15px;
    font-weight: 700;
  }
  .cozy-cat-banner-sub {
    font-size: 12px;
    font-weight: 400;
    opacity: 0.8;
  }

  /* ── Widget grid row ── */
  .cozy-card-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    width: 100%;
    max-width: 600px;
  }

  /* ── Cards ── */
  .cozy-card {
    padding: 16px;
    border-radius: 14px;
    border: 1px solid #e5e5e5;
    background: #fff;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 4px 10px rgba(0,0,0,0.03);
    position: relative;
    overflow: hidden;
    transition: all 0.2s ease;
  }
  .cozy-card:hover {
    transform: translateY(-3px);
    box-shadow: 0 6px 16px rgba(0,0,0,0.08);
    border-color: #ccc;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-card {
      border-color: #333;
      background: #1a1a1a;
      box-shadow: 0 4px 10px rgba(0,0,0,0.2);
    }
    .cozy-card:hover {
      box-shadow: 0 6px 16px rgba(0,0,0,0.3);
      border-color: #444;
    }
  }

  .cozy-card-icon {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    background: #f0f0f0;
    color: #111;
  }
  .cozy-card:hover .cozy-card-icon {
    transform: scale(1.15) rotate(-5deg);
    background: #000;
    color: #fff;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-card-icon {
      background: #2a2a2a;
      color: #eee;
    }
    .cozy-card:hover .cozy-card-icon {
      background: #fff;
      color: #000;
    }
  }

  .cozy-card-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #666;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-card-label { color: #aaa; }
  }

  .cozy-card-value {
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }

  .cozy-card-sub {
    font-size: 11.5px;
    font-weight: 400;
    color: #777;
    line-height: 1.4;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-card-sub { color: #999; }
  }

  .cozy-card-top {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  /* ── Chat card ── */
  .cozy-chat-card {
    width: 100%;
    max-width: 600px;
    padding: 0;
    border-radius: 16px;
    border: 1px solid #e5e5e5;
    background: #fff;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 6px 20px rgba(0,0,0,0.05);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-chat-card {
      border-color: #333;
      background: #1a1a1a;
      box-shadow: 0 6px 20px rgba(0,0,0,0.2);
    }
  }

  .cozy-chat-header {
    padding: 14px 18px;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: #444;
    border-bottom: 1px solid #f0f0f0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-chat-header {
      color: #bbb;
      border-bottom-color: #2a2a2a;
    }
  }

  .cozy-chat-header-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #000;
    animation: cozyPulse 2s ease-in-out infinite;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-chat-header-dot { background: #fff; }
  }
  
  @keyframes cozyPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.8); }
  }

  .cozy-messages {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px;
  }

  .cozy-msg {
    display: flex;
    max-width: 85%;
  }
  .cozy-msg--stella { align-self: flex-start; }
  .cozy-msg--user { align-self: flex-end; }

  .cozy-msg-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #000;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-right: 10px;
    margin-top: 2px;
    animation: catBounce 4s ease-in-out infinite reverse;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-msg-avatar {
      background: #fff;
      color: #000;
    }
  }

  .cozy-bubble {
    padding: 12px 16px;
    font-size: 13.5px;
    font-weight: 500;
    line-height: 1.5;
    letter-spacing: 0.01em;
  }

  .cozy-msg--stella .cozy-bubble {
    background: #f8f9fa;
    border: 1px solid #e0e0e0;
    border-radius: 16px 16px 16px 4px;
    color: #222;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-msg--stella .cozy-bubble {
      background: #222;
      border-color: #333;
      color: #eee;
    }
  }

  .cozy-msg--user .cozy-bubble {
    background: #000;
    border: 1px solid #000;
    border-radius: 16px 16px 4px 16px;
    color: #fff;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-msg--user .cozy-bubble {
      background: #fff;
      border-color: #fff;
      color: #000;
    }
  }

  .cozy-composer {
    display: flex;
    align-items: center;
    margin: 0 16px 16px;
    padding: 6px 6px 6px 16px;
    border-radius: 24px;
    background: #f8f9fa;
    border: 1px solid #e0e0e0;
    flex-shrink: 0;
    transition: border-color 0.2s ease;
  }
  .cozy-composer:hover {
    border-color: #ccc;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-composer {
      background: #222;
      border-color: #333;
    }
    .cozy-composer:hover {
      border-color: #555;
    }
  }

  .cozy-composer-text {
    flex: 1;
    font-size: 13px;
    font-weight: 400;
    color: #888;
    letter-spacing: 0.02em;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-composer-text { color: #777; }
  }

  .cozy-send-btn {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: none;
    background: #000;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    padding: 0;
    transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  }
  .cozy-send-btn:hover {
    transform: scale(1.1) rotate(-10deg);
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
  @media (prefers-color-scheme: dark) {
    .cozy-send-btn {
      background: #fff;
      color: #000;
      box-shadow: 0 2px 8px rgba(255,255,255,0.2);
    }
    .cozy-send-btn:hover {
      box-shadow: 0 4px 12px rgba(255,255,255,0.3);
    }
  }

  /* ── Progress bar ── */
  .cozy-progress-track {
    height: 8px;
    border-radius: 4px;
    background: #e0e0e0;
    overflow: hidden;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-progress-track { background: #333; }
  }
  .cozy-progress-fill {
    height: 100%;
    border-radius: 4px;
    background: #000;
    position: relative;
    overflow: hidden;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-progress-fill { background: #fff; }
  }
  .cozy-progress-fill::after {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 50%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
    animation: cozyProgressShine 2.5s infinite ease-in-out;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-progress-fill::after {
      background: linear-gradient(90deg, transparent, rgba(0,0,0,0.3), transparent);
    }
  }
  @keyframes cozyProgressShine {
    100% { left: 200%; }
  }

  /* ── Task items ── */
  .cozy-task {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
    transition: transform 0.2s ease;
  }
  .cozy-task:hover {
    transform: translateX(4px);
  }
  .cozy-task-check {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    border: 2px solid #ccc;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background: transparent;
    transition: all 0.2s ease;
  }
  .cozy-task-check.checked {
    background: #000;
    border-color: #000;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-task-check { border-color: #555; }
    .cozy-task-check.checked {
      background: #fff;
      border-color: #fff;
    }
  }
  .cozy-task-check.checked svg {
    stroke: #fff;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-task-check.checked svg { stroke: #000; }
  }

  .cozy-task-text {
    font-size: 13px;
    font-weight: 500;
    line-height: 1.4;
    transition: color 0.2s ease, opacity 0.2s ease;
  }
  .cozy-task-text.done {
    text-decoration: line-through;
    opacity: 0.4;
  }

  /* ── Fish bone divider ── */
  .cozy-fishbone {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px 0;
    color: #ccc;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-fishbone { color: #444; }
  }

  /* ── Paw trail footer ── */
  .cozy-paw-trail {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 12px 0;
    color: #000;
  }
  @media (prefers-color-scheme: dark) {
    .cozy-paw-trail { color: #fff; }
  }
  .cozy-paw-trail-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.15;
  }
`;

/* ── Inline SVG Components ── */

const CatFaceSVG = ({ size }: { size: number }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} fill="none" xmlns="http://www.w3.org/2000/svg">
    <g className="cat-head-group">
      {/* Ears */}
      <path className="cat-ear cat-ear-left" d="M20 50 L10 10 L45 35 Z" fill="currentColor" />
      <path className="cat-ear cat-ear-right" d="M80 50 L90 10 L55 35 Z" fill="currentColor" />
      {/* Head */}
      <path d="M20 50 Q 20 90, 50 90 Q 80 90, 80 50 Q 80 35, 50 35 Q 20 35, 20 50 Z" fill="currentColor" />
      {/* Eyes */}
      <g className="cat-eyes">
        <circle cx="35" cy="55" r="8" fill="var(--cat-eye-color, #FFF)" />
        <circle cx="65" cy="55" r="8" fill="var(--cat-eye-color, #FFF)" />
        <ellipse className="cat-pupil" cx="35" cy="55" rx="2" ry="6" fill="currentColor" />
        <ellipse className="cat-pupil" cx="65" cy="55" rx="2" ry="6" fill="currentColor" />
      </g>
      {/* Nose */}
      <path d="M45 65 L55 65 L50 70 Z" fill="var(--cat-nose-color, #333)" />
      {/* Mouth */}
      <path d="M50 70 Q 45 75, 40 73 M50 70 Q 55 75, 60 73" stroke="var(--cat-line-color, #f8f9fa)" strokeWidth="2" fill="none" strokeLinecap="round" />
      {/* Whiskers */}
      <g className="cat-whiskers" stroke="var(--cat-line-color, #f8f9fa)" strokeWidth="1.5" strokeLinecap="round">
        <path d="M30 65 L10 60" />
        <path d="M30 68 L8 68" />
        <path d="M30 71 L10 76" />
        <path d="M70 65 L90 60" />
        <path d="M70 68 L92 68" />
        <path d="M70 71 L90 76" />
      </g>
    </g>
  </svg>
);

const SleepingCatSVG = ({ size, style }: { size: number; style?: React.CSSProperties }) => (
  <div className="cozy-cat-watermark" style={{ ...style, width: size, height: size * 0.6 }}>
    <svg viewBox="0 0 200 120" width={size} height={size * 0.6} fill="none" xmlns="http://www.w3.org/2000/svg" style={{ overflow: "visible" }}>
      <g className="sleeping-cat-group">
        {/* Body */}
        <path className="cat-body-breathe" d="M40 90 Q 40 40, 100 40 Q 160 40, 160 90 Z" fill="currentColor" />
        {/* Tail */}
        <path className="cat-tail-curl" d="M150 85 Q 180 85, 180 65 Q 180 40, 150 40" stroke="currentColor" strokeWidth="20" strokeLinecap="round" fill="none" />
        {/* Head */}
        <circle cx="60" cy="70" r="25" fill="currentColor" className="cat-body-breathe" style={{ animationDelay: '0.2s' }} />
        {/* Ears */}
        <path d="M45 52 L35 35 L60 48 Z" fill="currentColor" className="cat-body-breathe" style={{ animationDelay: '0.2s' }} />
        <path d="M75 52 L85 35 L60 48 Z" fill="currentColor" className="cat-body-breathe" style={{ animationDelay: '0.2s' }} />
        {/* Sleeping Eyes */}
        <g className="cat-body-breathe" style={{ animationDelay: '0.2s' }}>
          <path d="M50 68 Q 55 72, 60 68 M65 68 Q 70 72, 75 68" stroke="var(--cat-line-color, #f8f9fa)" strokeWidth="2" fill="none" strokeLinecap="round" />
        </g>
        {/* Zzz */}
        <g className="cat-zzz-group" fill="currentColor">
          <text className="cat-zzz-1" x="90" y="40" fontSize="16" fontWeight="bold" fontFamily="sans-serif">Z</text>
          <text className="cat-zzz-2" x="110" y="25" fontSize="20" fontWeight="bold" fontFamily="sans-serif">z</text>
          <text className="cat-zzz-3" x="135" y="10" fontSize="24" fontWeight="bold" fontFamily="sans-serif">z</text>
        </g>
      </g>
    </svg>
  </div>
);

const CatPawSVG = ({ size }: { size: number }) => (
  <svg viewBox="0 0 100 100" width={size} height={size} fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <g className="cat-paw-group">
      <path d="M30 65 Q 30 90, 50 90 Q 70 90, 70 65 Q 70 50, 50 50 Q 30 50, 30 65 Z" />
      <circle cx="30" cy="35" r="12" />
      <circle cx="50" cy="20" r="14" />
      <circle cx="70" cy="35" r="12" />
    </g>
  </svg>
);

const PawDecoration = ({ size, style }: { size: number; style: React.CSSProperties }) => (
  <div className="cozy-paw-float" style={{ ...style, width: size, height: size }}>
    <CatPawSVG size={size} />
  </div>
);

const FishBoneSVG = () => (
  <svg viewBox="0 0 100 30" width="60" height="18" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
    <g className="fish-bone-wiggle">
      <line x1="20" y1="15" x2="80" y2="15" />
      <path d="M80 15 L90 5 L90 25 Z" fill="currentColor" stroke="none" />
      <circle cx="10" cy="15" r="6" strokeWidth="3" />
      <line x1="30" y1="15" x2="25" y2="5" />
      <line x1="30" y1="15" x2="25" y2="25" />
      <line x1="45" y1="15" x2="40" y2="5" />
      <line x1="45" y1="15" x2="40" y2="25" />
      <line x1="60" y1="15" x2="55" y2="5" />
      <line x1="60" y1="15" x2="55" y2="25" />
    </g>
  </svg>
);

export function CozyCatDemo() {
  return (
    <>
      <style>{css}</style>
      <div className="cozy-root">

        {/* ── Floating paw decorations ── */}
        <PawDecoration size={32} style={{ top: "6%", left: "5%", animationDelay: "0s", transform: "rotate(-15deg)" }} />
        <PawDecoration size={24} style={{ top: "18%", right: "7%", animationDelay: "-3s", transform: "rotate(20deg)" }} />
        <PawDecoration size={28} style={{ bottom: "28%", left: "3%", animationDelay: "-7s", transform: "rotate(-25deg)" }} />
        <PawDecoration size={22} style={{ bottom: "14%", right: "5%", animationDelay: "-10s", transform: "rotate(10deg)" }} />

        {/* ── Large sleeping cat watermark ── */}
        <SleepingCatSVG size={280} />

        {/* ── Top bar ── */}
        <div className="cozy-topbar">
          <div className="cozy-avatar">
            <CatFaceSVG size={28} />
          </div>
          <div className="cozy-greeting">
            Good afternoon
            <span className="cozy-greeting-paw">
              <CatPawSVG size={14} />
            </span>
          </div>
          <button className="cozy-settings-btn" aria-label="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>

        {/* ── Main scrollable content ── */}
        <div className="cozy-content">

          {/* ── Cat banner with illustration ── */}
          <div className="cozy-cat-banner">
            <div className="cozy-cat-banner-illustration">
              <CatFaceSVG size={56} />
            </div>
            <div className="cozy-cat-banner-text">
              <div className="cozy-cat-banner-title">Mochi is napping</div>
              <div className="cozy-cat-banner-sub">Last fed 2h ago &middot; Next: 4:30 PM</div>
            </div>
          </div>

          {/* ── Top widget row ── */}
          <div className="cozy-card-row">
            {/* Nap tracker */}
            <div className="cozy-card">
              <div className="cozy-card-top">
                <div className="cozy-card-icon">
                  <CatPawSVG size={18} />
                </div>
                <span className="cozy-card-label">Naps</span>
              </div>
              <div className="cozy-card-value">3</div>
              <div className="cozy-card-sub">Total today &middot; 4.5h</div>
            </div>

            {/* Treats card */}
            <div className="cozy-card">
              <div className="cozy-card-top">
                <div className="cozy-card-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z" />
                  </svg>
                </div>
                <span className="cozy-card-label">Treats</span>
              </div>
              <div className="cozy-card-value">5/8</div>
              <div className="cozy-card-sub">Daily limit</div>
            </div>

            {/* Mood card */}
            <div className="cozy-card">
              <div className="cozy-card-top">
                <div className="cozy-card-icon">
                  <CatFaceSVG size={18} />
                </div>
                <span className="cozy-card-label">Mood</span>
              </div>
              <div style={{ fontSize: "16px", fontWeight: 600 }}>Sleepy</div>
              <div className="cozy-card-sub">Since 2:15 PM</div>
            </div>
          </div>

          {/* ── Fish bone divider ── */}
          <div className="cozy-fishbone">
            <FishBoneSVG />
          </div>

          {/* ── Chat card ── */}
          <div className="cozy-chat-card">
            <div className="cozy-chat-header">
              <span className="cozy-chat-header-dot" />
              Chat with Stella
            </div>

            <div className="cozy-messages">
              <div className="cozy-msg cozy-msg--stella">
                <div className="cozy-msg-avatar">
                  <CatFaceSVG size={16} />
                </div>
                <span className="cozy-bubble">Mochi just woke up from a 2-hour nap on the windowsill. Want me to log it?</span>
              </div>

              <div className="cozy-msg cozy-msg--user">
                <span className="cozy-bubble">Yes! Also remind me to refill her water bowl</span>
              </div>

              <div className="cozy-msg cozy-msg--stella">
                <div className="cozy-msg-avatar">
                  <CatFaceSVG size={16} />
                </div>
                <span className="cozy-bubble">Done! Nap logged. I'll remind you about the water bowl in 30 minutes.</span>
              </div>
            </div>

            <div className="cozy-composer">
              <span className="cozy-composer-text">Say something...</span>
              <button className="cozy-send-btn" aria-label="Send">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </div>

          {/* ── Fish bone divider ── */}
          <div className="cozy-fishbone">
            <FishBoneSVG />
          </div>

          {/* ── Bottom widget row ── */}
          <div className="cozy-card-row">
            {/* Tasks */}
            <div className="cozy-card">
              <div className="cozy-card-top">
                <div className="cozy-card-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 11l3 3L22 4" />
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                  </svg>
                </div>
                <span className="cozy-card-label">Tasks</span>
              </div>
              <div className="cozy-task">
                <div className="cozy-task-check checked">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                </div>
                <span className="cozy-task-text done">Feed Mochi</span>
              </div>
              <div className="cozy-task">
                <div className="cozy-task-check checked">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12l5 5L20 7" />
                  </svg>
                </div>
                <span className="cozy-task-text done">Clean litter box</span>
              </div>
              <div className="cozy-task">
                <div className="cozy-task-check" />
                <span className="cozy-task-text">Vet appt Thursday</span>
              </div>
            </div>

            {/* Playtime */}
            <div className="cozy-card">
              <div className="cozy-card-top">
                <div className="cozy-card-icon">
                  <CatPawSVG size={18} />
                </div>
                <span className="cozy-card-label">Playtime</span>
              </div>
              <div className="cozy-card-value">22m</div>
              <div className="cozy-progress-track">
                <div className="cozy-progress-fill" style={{ width: "73%" }} />
              </div>
              <div className="cozy-card-sub">Goal: 30m daily</div>
            </div>

            {/* Cat tip */}
            <div className="cozy-card">
              <div className="cozy-card-top">
                <div className="cozy-card-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a7 7 0 0 0-7 7c0 3 2 5 4 6.5V18h6v-2.5c2-1.5 4-3.5 4-6.5a7 7 0 0 0-7-7z" />
                    <line x1="9" y1="21" x2="15" y2="21" />
                  </svg>
                </div>
                <span className="cozy-card-label">Cat Tip</span>
              </div>
              <div style={{ fontSize: "13px", fontWeight: 500, lineHeight: 1.5, fontStyle: "italic" }}>
                Cats knead when they feel safe. It's a sign of trust.
              </div>
            </div>
          </div>

          {/* ── Paw trail footer ── */}
          <div className="cozy-paw-trail">
            <div style={{ animation: "pawWalk 3s infinite 0s" }}><CatPawSVG size={16} /></div>
            <span className="cozy-paw-trail-dot" />
            <span className="cozy-paw-trail-dot" />
            <span className="cozy-paw-trail-dot" />
            <div style={{ animation: "pawWalk 3s infinite 0.6s" }}><CatPawSVG size={16} /></div>
            <span className="cozy-paw-trail-dot" />
            <span className="cozy-paw-trail-dot" />
            <span className="cozy-paw-trail-dot" />
            <div style={{ animation: "pawWalk 3s infinite 1.2s" }}><CatPawSVG size={16} /></div>
          </div>

        </div>
      </div>
    </>
  );
}
