import { useId } from "react";
import "./ConnectHeroAnimation.css";

/**
 * Phone ↔ desktop bridge hero — same illustration as the Connect dialog grid.
 */
export function ConnectHeroAnimation() {
  const uid = useId().replace(/:/g, "");
  const gradId = `signal-grad-${uid}`;

  return (
    <div className="connect-hero-animation" aria-hidden="true">
      <svg viewBox="0 0 400 140" className="connect-hero-svg">
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop
              offset="0%"
              stopColor="var(--interactive, var(--primary))"
              stopOpacity="0"
            />
            <stop
              offset="20%"
              stopColor="var(--interactive, var(--primary))"
              stopOpacity="0.8"
            />
            <stop
              offset="80%"
              stopColor="var(--interactive, var(--primary))"
              stopOpacity="0.8"
            />
            <stop
              offset="100%"
              stopColor="var(--interactive, var(--primary))"
              stopOpacity="0"
            />
          </linearGradient>
        </defs>

        <g className="anim-phone-group">
          <rect
            x="80"
            y="30"
            width="50"
            height="90"
            rx="8"
            fill="var(--background)"
            stroke="var(--border-strong)"
            strokeWidth="2"
          />
          <rect
            x="84"
            y="34"
            width="42"
            height="82"
            rx="4"
            fill="color-mix(in srgb, var(--card) 40%, transparent)"
            stroke="var(--border-weak)"
            strokeWidth="1"
          />
          <rect
            x="94"
            y="44"
            width="22"
            height="4"
            rx="2"
            fill="var(--border-strong)"
          />
          <rect
            x="94"
            y="54"
            width="16"
            height="4"
            rx="2"
            fill="var(--border-weak)"
          />
          <circle
            cx="105"
            cy="78"
            r="14"
            fill="var(--interactive, var(--primary))"
            opacity="0.1"
            className="anim-pulse"
          />
          <circle
            cx="105"
            cy="78"
            r="5"
            fill="var(--interactive, var(--primary))"
          />
          <g className="anim-cursor-phone">
            <path
              d="M106 71v-6a2 2 0 0 0-4 0v10.5l-1.5-1.5a2 2 0 0 0-2.8 2.8l4.8 4.8a5 5 0 0 0 7 0l1.5-1.5a2 2 0 0 0 0-2.8z"
              fill="var(--text-strong)"
              stroke="var(--background)"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <circle
              cx="105"
              cy="78"
              r="10"
              fill="var(--interactive, var(--primary))"
              opacity="0"
              className="anim-click-ripple-phone"
            />
          </g>
        </g>

        <g className="anim-signals">
          <path
            d="M 145 78 Q 190 50 235 65"
            fill="none"
            stroke={`url(#${gradId})`}
            strokeWidth="2.5"
            strokeDasharray="4 6"
            className="anim-signal-line"
          />
        </g>

        <g className="anim-monitor-group">
          <path
            d="M285 95 L275 115 H315 L305 95"
            fill="var(--background)"
            stroke="var(--border-strong)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M275 115 H315"
            stroke="var(--border-strong)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <rect
            x="240"
            y="25"
            width="110"
            height="70"
            rx="6"
            fill="var(--background)"
            stroke="var(--border-strong)"
            strokeWidth="2"
          />
          <rect
            x="244"
            y="29"
            width="102"
            height="62"
            rx="3"
            fill="color-mix(in srgb, var(--card) 40%, transparent)"
            stroke="var(--border-weak)"
            strokeWidth="1"
          />
          <rect
            x="254"
            y="38"
            width="40"
            height="5"
            rx="2.5"
            fill="var(--border-strong)"
          />
          <rect
            x="254"
            y="50"
            width="30"
            height="4"
            rx="2"
            fill="var(--border-weak)"
          />
          <rect
            x="254"
            y="60"
            width="60"
            height="4"
            rx="2"
            fill="var(--border-weak)"
          />
          <g className="anim-cursor">
            <path
              d="M280 50 L292 62 L286 63 L289 70 L285 71 L282 64 L276 68 Z"
              fill="var(--text-strong)"
              stroke="var(--background)"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <circle
              cx="280"
              cy="50"
              r="10"
              fill="var(--interactive, var(--primary))"
              opacity="0"
              className="anim-click-ripple"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
