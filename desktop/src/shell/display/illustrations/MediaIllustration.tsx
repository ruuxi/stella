export function MediaIllustration({ className = "" }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="100%" height="100%">
      <defs>
        <style>{`
          .anim-float-1 { animation: float1 6s ease-in-out infinite; }
          .anim-float-2 { animation: float2 5s ease-in-out infinite; }
          .anim-photo { animation: floatPhoto 7s ease-in-out infinite; transform-origin: 140px 140px; }
          .anim-video { animation: floatVideo 6s ease-in-out infinite; transform-origin: 220px 160px; }
          .anim-audio { animation: floatAudio 5s ease-in-out infinite; transform-origin: 280px 100px; }
          .anim-play { animation: pulsePlay 2s ease-in-out infinite; transform-origin: 220px 160px; }

          @keyframes float1 { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
          @keyframes float2 { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(12px); } }
          @keyframes floatPhoto { 0%, 100% { transform: translateY(0) rotate(-6deg); } 50% { transform: translateY(-12px) rotate(-2deg); } }
          @keyframes floatVideo { 0%, 100% { transform: translateY(0) rotate(4deg); } 50% { transform: translateY(8px) rotate(6deg); } }
          @keyframes floatAudio { 0%, 100% { transform: translateY(0) rotate(12deg); } 50% { transform: translateY(-15px) rotate(18deg); } }
          @keyframes pulsePlay { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.1); } }
        `}</style>
        <filter id="shadow-sm" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.1" />
        </filter>
        <filter id="shadow-md" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="2" dy="4" stdDeviation="4" floodOpacity="0.15" />
        </filter>
      </defs>

      <g className="anim-float-1">
        <circle cx="80" cy="70" r="10" fill="#e2e8f0" />
        <rect x="320" y="220" width="16" height="16" rx="4" fill="#e2e8f0" transform="rotate(15 328 228)" />
      </g>
      <g className="anim-float-2">
        <polygon points="340,80 325,105 355,105" fill="#f1f5f9" transform="rotate(-20 340 95)" />
        <circle cx="100" cy="240" r="8" fill="#f1f5f9" />
      </g>

      <g className="anim-photo" filter="url(#shadow-md)">
        <rect x="80" y="80" width="120" height="140" rx="8" fill="#ffffff" />
        <rect x="90" y="90" width="100" height="100" rx="4" fill="#38bdf8" />
        <circle cx="120" cy="115" r="12" fill="#fbbf24" />
        <path d="M 90 190 L 120 150 L 150 180 L 160 165 L 190 190 Z" fill="#ffffff" opacity="0.9" />
      </g>

      <g className="anim-video" filter="url(#shadow-md)">
        <rect x="140" y="110" width="160" height="100" rx="12" fill="#1e293b" />
        <rect x="150" y="120" width="140" height="70" rx="6" fill="#0f172a" />
        <g className="anim-play">
          <circle cx="220" cy="155" r="16" fill="#f43f5e" />
          <polygon points="215,147 215,163 229,155" fill="#ffffff" />
        </g>
        <rect x="150" y="198" width="140" height="4" rx="2" fill="#334155" />
        <rect x="150" y="198" width="60" height="4" rx="2" fill="#f43f5e" />
      </g>

      <g className="anim-audio" filter="url(#shadow-sm)">
        <rect x="240" y="70" width="80" height="80" rx="24" fill="#ffffff" />
        <path d="M270 100 L295 95 L295 125 A10 10 0 1 1 275 125 L275 105 L270 106 Z" fill="#8b5cf6" />
      </g>
    </svg>
  );
}
