export function ChatIllustration({ className = "" }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="100%" height="100%">
      <defs>
        <style>{`
          .anim-float-1 { animation: float1 6s ease-in-out infinite; }
          .anim-float-2 { animation: float2 5s ease-in-out infinite; }
          .anim-bubble-a { animation: popBubbleA 5s ease-in-out infinite; transform-origin: 80px 210px; }
          .anim-bubble-b { animation: popBubbleB 5s ease-in-out infinite; transform-origin: 320px 140px; }
          .anim-dot-1 { animation: typeDot 1.5s infinite 0s; }
          .anim-dot-2 { animation: typeDot 1.5s infinite 0.2s; }
          .anim-dot-3 { animation: typeDot 1.5s infinite 0.4s; }
          .anim-heart { animation: floatHeart 5s ease-in-out infinite; transform-origin: 150px 140px; }

          @keyframes float1 { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
          @keyframes float2 { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(12px); } }
          @keyframes popBubbleA { 0%, 10% { transform: scale(0); opacity: 0; } 20%, 90% { transform: scale(1); opacity: 1; } 95%, 100% { transform: scale(0); opacity: 0; } }
          @keyframes popBubbleB { 0%, 25% { transform: scale(0); opacity: 0; } 35%, 85% { transform: scale(1); opacity: 1; } 90%, 100% { transform: scale(0); opacity: 0; } }
          @keyframes typeDot { 0%, 100% { transform: translateY(0); opacity: 0.4; } 50% { transform: translateY(-4px); opacity: 1; } }
          @keyframes floatHeart { 0%, 40% { transform: translate(0, 0) scale(0); opacity: 0; } 45% { transform: translate(0, -10px) scale(1.2); opacity: 1; } 50%, 80% { transform: translate(0, -15px) scale(1); opacity: 1; } 85%, 100% { transform: translate(0, -25px) scale(0); opacity: 0; } }
        `}</style>
        <filter id="shadow-sm" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.1" />
        </filter>
        <filter id="shadow-md" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="2" dy="4" stdDeviation="4" floodOpacity="0.15" />
        </filter>
      </defs>

      <g className="anim-float-1">
        <circle cx="90" cy="80" r="12" fill="#e2e8f0" />
        <rect x="290" y="210" width="20" height="20" rx="4" fill="#e2e8f0" transform="rotate(15 300 220)" />
      </g>
      <g className="anim-float-2">
        <polygon points="320,80 305,105 335,105" fill="#f1f5f9" transform="rotate(-20 320 95)" />
        <circle cx="110" cy="220" r="8" fill="#f1f5f9" />
      </g>

      <g className="anim-bubble-a" filter="url(#shadow-md)">
        <path d="M 80 190 L 60 210 L 100 200 Z" fill="#4f46e5" />
        <rect x="80" y="130" width="160" height="80" rx="16" fill="#4f46e5" />
        <rect x="100" y="155" width="100" height="8" rx="4" fill="#ffffff" opacity="0.9" />
        <rect x="100" y="175" width="60" height="8" rx="4" fill="#ffffff" opacity="0.9" />
      </g>

      <g className="anim-bubble-b" filter="url(#shadow-md)">
        <path d="M 320 130 L 340 150 L 300 140 Z" fill="#ffffff" />
        <rect x="180" y="80" width="140" height="70" rx="16" fill="#ffffff" />
        <circle cx="230" cy="115" r="5" fill="#94a3b8" className="anim-dot-1" />
        <circle cx="250" cy="115" r="5" fill="#94a3b8" className="anim-dot-2" />
        <circle cx="270" cy="115" r="5" fill="#94a3b8" className="anim-dot-3" />
      </g>

      <g className="anim-heart" filter="url(#shadow-sm)">
        <path d="M150 110 C 150 110, 140 100, 130 110 C 120 120, 150 140, 150 140 C 150 140, 180 120, 170 110 C 160 100, 150 110, 150 110 Z" fill="#e11d48" />
      </g>
    </svg>
  );
}
