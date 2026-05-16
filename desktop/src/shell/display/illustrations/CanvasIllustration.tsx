export function CanvasIllustration({ className = "" }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="100%" height="100%">
      <defs>
        <style>{`
          .anim-float-1 { animation: float1 6s ease-in-out infinite; }
          .anim-float-2 { animation: float2 5s ease-in-out infinite; }
          .anim-window { animation: floatWindow 8s ease-in-out infinite; }
          .anim-cursor { animation: moveCursor 6s ease-in-out infinite; }
          .anim-block { animation: placeBlock 6s ease-in-out infinite; transform-origin: 200px 150px; }
          .anim-sparkle { animation: popSparkle 6s ease-out infinite; transform-origin: 220px 130px; }

          @keyframes float1 { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
          @keyframes float2 { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(12px); } }
          @keyframes floatWindow { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-6px); } }
          @keyframes moveCursor { 0%, 15% { transform: translate(250px, 250px); opacity: 0; } 25%, 35% { transform: translate(200px, 150px); opacity: 1; } 45%, 65% { transform: translate(160px, 120px); opacity: 1; } 75%, 85% { transform: translate(200px, 150px); opacity: 1; } 100% { transform: translate(250px, 250px); opacity: 0; } }
          @keyframes placeBlock { 0%, 40% { transform: scale(0); opacity: 0; } 45%, 85% { transform: scale(1); opacity: 1; } 90%, 100% { transform: scale(0); opacity: 0; } }
          @keyframes popSparkle { 0%, 40% { transform: scale(0) rotate(0deg); opacity: 0; } 45% { transform: scale(1.2) rotate(90deg); opacity: 1; } 50%, 80% { transform: scale(1) rotate(180deg); opacity: 1; } 85%, 100% { transform: scale(0) rotate(270deg); opacity: 0; } }
        `}</style>
        <filter id="shadow-sm" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.1" />
        </filter>
        <filter id="shadow-md" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="2" dy="4" stdDeviation="4" floodOpacity="0.15" />
        </filter>
      </defs>

      <g className="anim-float-1">
        <circle cx="70" cy="90" r="10" fill="#e2e8f0" />
        <rect x="310" y="200" width="16" height="16" rx="4" fill="#e2e8f0" transform="rotate(25 318 208)" />
      </g>
      <g className="anim-float-2">
        <polygon points="330,70 315,95 345,95" fill="#f1f5f9" transform="rotate(-15 330 85)" />
        <circle cx="90" cy="230" r="8" fill="#f1f5f9" />
      </g>

      <g className="anim-window" filter="url(#shadow-md)">
        <rect x="80" y="60" width="240" height="160" rx="12" fill="#ffffff" />
        <path d="M 80 72 C 80 65.373 85.373 60 92 60 L 308 60 C 314.627 60 320 65.373 320 72 L 320 90 L 80 90 Z" fill="#f1f5f9" />
        <circle cx="100" cy="75" r="4" fill="#f43f5e" />
        <circle cx="115" cy="75" r="4" fill="#fbbf24" />
        <circle cx="130" cy="75" r="4" fill="#10b981" />
        <rect x="80" y="90" width="60" height="130" fill="#f8fafc" />
        <rect x="90" y="105" width="40" height="6" rx="3" fill="#e2e8f0" />
        <rect x="90" y="120" width="30" height="6" rx="3" fill="#e2e8f0" />
        <rect x="160" y="110" width="140" height="90" rx="8" fill="#f1f5f9" stroke="#e2e8f0" strokeWidth="2" strokeDasharray="4 4" />
      </g>

      <g className="anim-block" filter="url(#shadow-sm)">
        <rect x="170" y="120" width="120" height="70" rx="6" fill="#c084fc" />
        <rect x="185" y="140" width="90" height="8" rx="4" fill="#ffffff" opacity="0.9" />
        <rect x="185" y="160" width="60" height="8" rx="4" fill="#ffffff" opacity="0.9" />
      </g>

      <g className="anim-sparkle">
        <path d="M220 110 C 220 125, 205 130, 205 130 C 205 130, 220 135, 220 150 C 220 135, 235 130, 235 130 C 235 130, 220 125, 220 110 Z" fill="#fbbf24" />
      </g>

      <g className="anim-cursor" filter="url(#shadow-md)">
        <path d="M0,0 L0,24 L6,18 L11,29 L14,27 L9,16 L18,16 Z" fill="#0f172a" stroke="#ffffff" strokeWidth="2" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
