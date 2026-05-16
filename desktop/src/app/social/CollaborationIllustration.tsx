import { useEffect, useRef, useState } from "react";

export function CollaborationIllustration({
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
            svg[data-running="false"] .anim-body,
            svg[data-running="false"] .anim-roof,
            svg[data-running="false"] .anim-cursor-a,
            svg[data-running="false"] .anim-cursor-b,
            svg[data-running="false"] .anim-sparkle,
            svg[data-running="false"] .anim-float-1,
            svg[data-running="false"] .anim-float-2 {
              animation-play-state: paused;
            }

            .anim-body { animation: buildBody 5s ease-in-out infinite; }
            .anim-roof { animation: buildRoof 5s ease-in-out infinite; }
            .anim-cursor-a { animation: moveCursorA 5s ease-in-out infinite; }
            .anim-cursor-b { animation: moveCursorB 5s ease-in-out infinite; }
            .anim-sparkle { 
              animation: popSparkle 5s ease-out infinite; 
              transform-origin: 200px 150px; 
            }
            .anim-float-1 { animation: float1 6s ease-in-out infinite; }
            .anim-float-2 { animation: float2 5s ease-in-out infinite; }

            @keyframes buildBody {
              0%, 15% { transform: translate(70px, 40px); opacity: 0; }
              25%, 35% { transform: translate(70px, 40px); opacity: 1; }
              45%, 65% { transform: translate(0px, 0px); opacity: 1; }
              75%, 85% { transform: translate(70px, 40px); opacity: 1; }
              100% { transform: translate(70px, 40px); opacity: 0; }
            }

            @keyframes buildRoof {
              0%, 15% { transform: translate(-70px, -50px); opacity: 0; }
              25%, 35% { transform: translate(-70px, -50px); opacity: 1; }
              45%, 65% { transform: translate(0px, 0px); opacity: 1; }
              75%, 85% { transform: translate(-70px, -50px); opacity: 1; }
              100% { transform: translate(-70px, -50px); opacity: 0; }
            }

            @keyframes moveCursorA {
              0%, 15% { transform: translate(250px, 300px); opacity: 0; }
              25%, 35% { transform: translate(250px, 210px); opacity: 1; }
              45%, 65% { transform: translate(180px, 170px); opacity: 1; }
              75%, 85% { transform: translate(250px, 210px); opacity: 1; }
              100% { transform: translate(250px, 300px); opacity: 0; }
            }

            @keyframes moveCursorB {
              0%, 15% { transform: translate(130px, -50px); opacity: 0; }
              25%, 35% { transform: translate(130px, 50px); opacity: 1; }
              45%, 65% { transform: translate(200px, 100px); opacity: 1; }
              75%, 85% { transform: translate(130px, 50px); opacity: 1; }
              100% { transform: translate(130px, -50px); opacity: 0; }
            }

            @keyframes popSparkle {
              0%, 40% { transform: scale(0) rotate(0deg); opacity: 0; }
              45% { transform: scale(1.2) rotate(90deg); opacity: 1; }
              50%, 65% { transform: scale(1) rotate(180deg); opacity: 1; }
              70%, 100% { transform: scale(0) rotate(270deg); opacity: 0; }
            }

            @keyframes float1 {
              0%, 100% { transform: translateY(0px); }
              50% { transform: translateY(-10px); }
            }

            @keyframes float2 {
              0%, 100% { transform: translateY(0px); }
              50% { transform: translateY(12px); }
            }
          `}
        </style>
        <filter id="shadow-sm" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.1" />
        </filter>
      </defs>

      <g className="anim-float-1">
        <circle cx="90" cy="80" r="12" fill="#e2e8f0" />
        <rect
          x="290"
          y="210"
          width="20"
          height="20"
          rx="4"
          fill="#e2e8f0"
          transform="rotate(15 300 220)"
        />
      </g>
      <g className="anim-float-2">
        <polygon
          points="320,80 305,105 335,105"
          fill="#f1f5f9"
          transform="rotate(-20 320 95)"
        />
        <circle cx="110" cy="220" r="8" fill="#f1f5f9" />
      </g>

      <path
        d="M120 235 L280 235"
        stroke="#cbd5e1"
        strokeWidth="4"
        strokeLinecap="round"
      />

      <g className="anim-body" filter="url(#shadow-sm)">
        <rect x="160" y="155" width="80" height="80" rx="8" fill="#c084fc" />
        <circle cx="200" cy="195" r="16" fill="#ffffff" opacity="0.9" />
      </g>

      <g className="anim-roof" filter="url(#shadow-sm)">
        <path d="M145 155 L200 100 L255 155 Z" fill="#38bdf8" />
      </g>

      <g className="anim-sparkle">
        <path
          d="M200 120 C 200 145, 175 150, 175 150 C 175 150, 200 155, 200 180 C 200 155, 225 150, 225 150 C 225 150, 200 145, 200 120 Z"
          fill="#fbbf24"
        />
      </g>

      <g className="anim-cursor-a">
        <path
          d="M0,0 L0,24 L6,18 L11,29 L14,27 L9,16 L18,16 Z"
          fill="#4f46e5"
          stroke="#ffffff"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <rect x="16" y="22" width="40" height="18" rx="4" fill="#4f46e5" />
        <text
          x="36"
          y="34"
          fontFamily="sans-serif"
          fontSize="10"
          fill="white"
          fontWeight="600"
          textAnchor="middle"
        >
          You
        </text>
      </g>

      <g className="anim-cursor-b">
        <path
          d="M0,0 L0,24 L6,18 L11,29 L14,27 L9,16 L18,16 Z"
          fill="#e11d48"
          stroke="#ffffff"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <rect x="16" y="22" width="50" height="18" rx="4" fill="#e11d48" />
        <text
          x="41"
          y="34"
          fontFamily="sans-serif"
          fontSize="10"
          fill="white"
          fontWeight="600"
          textAnchor="middle"
        >
          Friend
        </text>
      </g>
    </svg>
  );
}
