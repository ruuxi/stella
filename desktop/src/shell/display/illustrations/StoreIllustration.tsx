export function StoreIllustration({ className = "" }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="100%" height="100%">
      <defs>
        <style>{`
          .anim-float-1 { animation: float1 6s ease-in-out infinite; }
          .anim-float-2 { animation: float2 5s ease-in-out infinite; }
          .anim-box { animation: floatBox 5s ease-in-out infinite; transform-origin: 200px 180px; }
          .anim-item-1 { animation: popItem1 5s ease-in-out infinite; transform-origin: 200px 180px; }
          .anim-item-2 { animation: popItem2 5s ease-in-out infinite; transform-origin: 200px 180px; }
          .anim-item-3 { animation: popItem3 5s ease-in-out infinite; transform-origin: 200px 180px; }
          .anim-sparkle { animation: popSparkle 5s ease-out infinite; transform-origin: 240px 100px; }

          @keyframes float1 { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
          @keyframes float2 { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(12px); } }
          @keyframes floatBox { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(8px); } }
          @keyframes popItem1 { 0%, 15% { transform: translate(0, 0) scale(0.5); opacity: 0; } 25%, 85% { transform: translate(-40px, -60px) scale(1) rotate(-10deg); opacity: 1; } 95%, 100% { transform: translate(0, 0) scale(0.5); opacity: 0; } }
          @keyframes popItem2 { 0%, 20% { transform: translate(0, 0) scale(0.5); opacity: 0; } 30%, 80% { transform: translate(0px, -80px) scale(1) rotate(5deg); opacity: 1; } 90%, 100% { transform: translate(0, 0) scale(0.5); opacity: 0; } }
          @keyframes popItem3 { 0%, 25% { transform: translate(0, 0) scale(0.5); opacity: 0; } 35%, 75% { transform: translate(50px, -50px) scale(1) rotate(15deg); opacity: 1; } 85%, 100% { transform: translate(0, 0) scale(0.5); opacity: 0; } }
          @keyframes popSparkle { 0%, 30% { transform: scale(0) rotate(0deg); opacity: 0; } 35% { transform: scale(1.2) rotate(90deg); opacity: 1; } 40%, 70% { transform: scale(1) rotate(180deg); opacity: 1; } 75%, 100% { transform: scale(0) rotate(270deg); opacity: 0; } }
        `}</style>
        <filter id="shadow-sm" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.1" />
        </filter>
        <filter id="shadow-md" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="2" dy="4" stdDeviation="4" floodOpacity="0.15" />
        </filter>
      </defs>

      <g className="anim-float-1">
        <circle cx="90" cy="80" r="10" fill="#e2e8f0" />
        <rect x="300" y="220" width="16" height="16" rx="4" fill="#e2e8f0" transform="rotate(15 308 228)" />
      </g>
      <g className="anim-float-2">
        <polygon points="320,70 305,95 335,95" fill="#f1f5f9" transform="rotate(-20 320 85)" />
        <circle cx="110" cy="230" r="8" fill="#f1f5f9" />
      </g>

      <g className="anim-item-1" filter="url(#shadow-sm)">
        <rect x="180" y="160" width="40" height="40" rx="8" fill="#f43f5e" />
        <circle cx="200" cy="180" r="10" fill="#ffffff" opacity="0.9" />
      </g>

      <g className="anim-item-2" filter="url(#shadow-md)">
        <rect x="170" y="150" width="60" height="70" rx="8" fill="#ffffff" />
        <rect x="180" y="165" width="40" height="6" rx="3" fill="#e2e8f0" />
        <rect x="180" y="180" width="30" height="6" rx="3" fill="#e2e8f0" />
        <rect x="180" y="195" width="35" height="6" rx="3" fill="#e2e8f0" />
        <path d="M 210 150 L 230 150 L 230 170 Z" fill="#cbd5e1" />
      </g>

      <g className="anim-item-3" filter="url(#shadow-sm)">
        <rect x="180" y="160" width="40" height="40" rx="8" fill="#10b981" />
        <polygon points="200,170 210,185 190,185" fill="#ffffff" opacity="0.9" />
      </g>

      <g className="anim-box" filter="url(#shadow-md)">
        <path d="M 140 160 C 140 150, 260 150, 260 160 L 250 240 C 250 250, 150 250, 150 240 Z" fill="#8b5cf6" />
        <path d="M 140 160 C 140 170, 260 170, 260 160" fill="#7c3aed" />
        <path d="M 180 165 C 180 130, 220 130, 220 165" fill="none" stroke="#c4b5fd" strokeWidth="8" strokeLinecap="round" />
        <rect x="185" y="190" width="30" height="20" rx="6" fill="#ffffff" opacity="0.3" />
      </g>

      <g className="anim-sparkle">
        <path d="M240 90 C 240 105, 225 110, 225 110 C 225 110, 240 115, 240 130 C 240 115, 255 110, 255 110 C 255 110, 240 105, 240 90 Z" fill="#fbbf24" />
      </g>
    </svg>
  );
}
