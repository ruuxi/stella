import { useEffect, useRef, useState } from "react";

export function AppCreationIllustration({
  className = "",
}: {
  className?: string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [inView, setInView] = useState(false);
  const [docVisible, setDocVisible] = useState(
    typeof document === "undefined" ? true : !document.hidden,
  );

  useEffect(() => {
    const node = svgRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting);
      },
      { threshold: 0.01 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onVisibility = () => setDocVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const running = inView && docVisible;

  return (
    <svg
      ref={svgRef}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 400 300"
      width="100%"
      height="100%"
      data-running={running ? "true" : "false"}
    >
      <defs>
        <style>
          {`
            svg[data-running="false"] .anim-window,
            svg[data-running="false"] .anim-sidebar,
            svg[data-running="false"] .anim-card,
            svg[data-running="false"] .anim-cursor,
            svg[data-running="false"] .anim-sparkle,
            svg[data-running="false"] .anim-ripple,
            svg[data-running="false"] .anim-float-1,
            svg[data-running="false"] .anim-float-2 {
              animation-play-state: paused;
            }

            .anim-window { animation: floatWindow 6s ease-in-out infinite; }
            .anim-sidebar { animation: slideSidebar 6s ease-in-out infinite; }
            .anim-card { animation: popCard 6s ease-in-out infinite; }
            .anim-cursor { animation: moveStellaCursor 6s ease-in-out infinite; }
            .anim-sparkle { 
              animation: popSparkle 6s ease-out infinite; 
              transform-origin: 220px 160px; 
            }
            .anim-ripple {
              animation: rippleEffect 6s cubic-bezier(0.1, 0.8, 0.3, 1) infinite;
              transform-origin: 220px 160px;
            }
            .anim-float-1 { animation: float1 6s ease-in-out infinite; }
            .anim-float-2 { animation: float2 5s ease-in-out infinite; }

            @keyframes floatWindow {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-6px); }
            }

            @keyframes slideSidebar {
              0%, 15% { transform: scaleX(0); opacity: 0; transform-origin: 110px 162px; }
              22%, 85% { transform: scaleX(1); opacity: 1; transform-origin: 110px 162px; }
              92%, 100% { transform: scaleX(0); opacity: 0; transform-origin: 110px 162px; }
            }

            @keyframes popCard {
              0%, 42% { transform: scale(0); opacity: 0; transform-origin: 226px 162px; }
              48%, 85% { transform: scale(1); opacity: 1; transform-origin: 226px 162px; }
              92%, 100% { transform: scale(0); opacity: 0; transform-origin: 226px 162px; }
            }

            @keyframes moveStellaCursor {
              0%, 10% { transform: translate(320px, 280px); opacity: 0; }
              25%, 35% { transform: translate(220px, 160px); opacity: 1; }
              38% { transform: translate(218px, 162px) scale(0.95); opacity: 1; }
              42% { transform: translate(220px, 160px) scale(1); opacity: 1; }
              55%, 85% { transform: translate(260px, 220px); opacity: 1; }
              95%, 100% { transform: translate(320px, 280px); opacity: 0; }
            }

            @keyframes popSparkle {
              0%, 38% { transform: scale(0) rotate(0deg); opacity: 0; }
              42% { transform: scale(1.3) rotate(45deg); opacity: 1; }
              48%, 80% { transform: scale(1) rotate(90deg); opacity: 1; }
              88%, 100% { transform: scale(0) rotate(135deg); opacity: 0; }
            }

            @keyframes rippleEffect {
              0%, 38% { transform: scale(0); opacity: 0; }
              39% { opacity: 0.8; }
              48% { transform: scale(2.5); opacity: 0; }
              100% { transform: scale(2.5); opacity: 0; }
            }

            @keyframes float1 {
              0%, 100% { transform: translateY(0px); }
              50% { transform: translateY(-8px); }
            }

            @keyframes float2 {
              0%, 100% { transform: translateY(0px); }
              50% { transform: translateY(10px); }
            }
          `}
        </style>
        <filter id="shadow-sm" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.08" />
        </filter>
      </defs>

      {/* Floating background shapes */}
      <g className="anim-float-1">
        <circle cx="80" cy="70" r="10" fill="#ffffff" opacity="0.9" />
        <rect
          x="310"
          y="200"
          width="16"
          height="16"
          rx="4"
          fill="#ffffff"
          opacity="0.85"
          transform="rotate(25 318 208)"
        />
      </g>
      <g className="anim-float-2">
        <polygon
          points="320,70 308,90 332,90"
          fill="#ffffff"
          opacity="0.8"
          transform="rotate(-15 320 80)"
        />
        <circle cx="90" cy="230" r="6" fill="#ffffff" opacity="0.9" />
      </g>

      {/* Ground/baseline */}
      <path
        d="M100 245 L300 245"
        stroke="var(--border-strong, var(--border))"
        strokeWidth="3"
        strokeLinecap="round"
        opacity="0.8"
      />

      {/* Main App Window canvas */}
      <g className="anim-window" filter="url(#shadow-sm)">
        {/* Outer frame */}
        <rect
          x="100"
          y="80"
          width="200"
          height="140"
          rx="12"
          fill="color-mix(in oklch, var(--card) 95%, transparent)"
          stroke="var(--border-strong)"
          strokeWidth="1.5"
        />

        {/* Title bar */}
        <path
          d="M100 92 L300 92"
          stroke="var(--border)"
          strokeWidth="1"
        />
        {/* Title bar buttons (traffic lights) */}
        <circle cx="114" cy="86" r="3" fill="#ff5f56" />
        <circle cx="122" cy="86" r="3" fill="#ffbd2e" />
        <circle cx="130" cy="86" r="3" fill="#27c93f" />

        {/* Inner layout container */}
        <g opacity="0.85">
          {/* Top layout / search bar preview */}
          <rect
            x="142"
            y="83"
            width="60"
            height="6"
            rx="3"
            fill="color-mix(in oklch, var(--foreground) 10%, transparent)"
          />

          {/* Sidebar */}
          <g className="anim-sidebar">
            <rect
              x="110"
              y="100"
              width="40"
              height="110"
              rx="6"
              fill="color-mix(in oklch, var(--foreground) 3%, transparent)"
              stroke="var(--border)"
              strokeWidth="1"
            />
            {/* Sidebar elements */}
            <rect x="116" y="108" width="28" height="5" rx="2.5" fill="color-mix(in oklch, var(--foreground) 15%, transparent)" />
            <rect x="116" y="120" width="28" height="5" rx="2.5" fill="color-mix(in oklch, var(--foreground) 10%, transparent)" />
            <rect x="116" y="132" width="28" height="5" rx="2.5" fill="color-mix(in oklch, var(--foreground) 10%, transparent)" />
            <circle cx="120" cy="196" r="5" fill="color-mix(in oklch, var(--foreground) 12%, transparent)" />
            <rect x="130" y="194" width="14" height="4" rx="2" fill="color-mix(in oklch, var(--foreground) 10%, transparent)" />
          </g>

          {/* App Canvas Area */}
          <rect
            x="156"
            y="100"
            width="134"
            height="110"
            rx="6"
            fill="color-mix(in oklch, var(--foreground) 1.5%, transparent)"
            stroke="var(--border)"
            strokeWidth="1"
          />

          {/* App UI Card - the created app */}
          <g className="anim-card" filter="url(#shadow-sm)">
            <rect
              x="166"
              y="110"
              width="114"
              height="90"
              rx="8"
              fill="color-mix(in oklch, var(--card) 98%, transparent)"
              stroke="color-mix(in oklch, var(--primary) 30%, transparent)"
              strokeWidth="1.5"
            />
            {/* App title */}
            <rect x="174" y="118" width="45" height="6" rx="3" fill="var(--primary)" opacity="0.8" />
            <rect x="174" y="128" width="98" height="4" rx="2" fill="color-mix(in oklch, var(--foreground) 15%, transparent)" />

            {/* App UI Graph representation */}
            <path
              d="M174 180 L195 160 L215 170 L235 150 L255 165 L272 145"
              fill="none"
              stroke="var(--primary)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="235" cy="150" r="3" fill="var(--primary)" />
            <circle cx="272" cy="145" r="3" fill="var(--primary)" />
          </g>
        </g>
      </g>

      {/* Click ripple circle */}
      <circle
        className="anim-ripple"
        cx="220"
        cy="160"
        r="12"
        fill="none"
        stroke="var(--primary)"
        strokeWidth="1.5"
      />

      {/* Sparkle pop */}
      <g className="anim-sparkle">
        <path
          d="M220 145 C 220 156, 205 160, 205 160 C 205 160, 220 164, 220 175 C 220 164, 235 160, 235 160 C 235 160, 220 156, 220 145 Z"
          fill="#fbbf24"
        />
      </g>

      {/* Stella Cursor */}
      <g className="anim-cursor" filter="url(#shadow-sm)">
        <path
          d="M0,0 L0,24 L6,18 L11,29 L14,27 L9,16 L18,16 Z"
          fill="var(--primary)"
          stroke="#ffffff"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <rect x="16" y="22" width="42" height="18" rx="4" fill="var(--primary)" />
        <text
          x="37"
          y="34"
          fontFamily="var(--font-family-sans, sans-serif)"
          fontSize="10"
          fill="var(--primary-foreground, white)"
          fontWeight="600"
          textAnchor="middle"
        >
          Stella
        </text>
      </g>
    </svg>
  );
}
