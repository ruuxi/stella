export function TrashIllustration({ className = "" }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="100%" height="100%">
      <defs>
        <style>{`
          .anim-float-1 { animation: float1 6s ease-in-out infinite; }
          .anim-float-2 { animation: float2 5s ease-in-out infinite; }
          .anim-bin { animation: jiggleBin 4s ease-in-out infinite; transform-origin: 200px 240px; }
          .anim-lid { animation: openLid 4s ease-in-out infinite; transform-origin: 260px 120px; }
          .anim-paper-1 { animation: tossPaper1 4s ease-in-out infinite; transform-origin: 120px 80px; }
          .anim-paper-2 { animation: tossPaper2 4s ease-in-out infinite; transform-origin: 140px 100px; }
          .anim-dust { animation: puffDust 4s ease-out infinite; transform-origin: 200px 150px; }

          @keyframes float1 { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-10px); } }
          @keyframes float2 { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(12px); } }
          @keyframes jiggleBin { 0%, 30%, 60%, 100% { transform: rotate(0deg); } 35% { transform: rotate(-2deg); } 45% { transform: rotate(2deg); } 55% { transform: rotate(-1deg); } }
          @keyframes openLid { 0%, 100% { transform: rotate(0deg); } 15%, 45% { transform: rotate(35deg); } }
          @keyframes tossPaper1 { 0%, 5% { transform: translate(-60px, -60px) rotate(0deg) scale(0.5); opacity: 0; } 15% { opacity: 1; transform: translate(-30px, -30px) rotate(90deg) scale(1); } 25%, 100% { transform: translate(80px, 60px) rotate(180deg) scale(0.5); opacity: 0; } }
          @keyframes tossPaper2 { 0%, 10% { transform: translate(-80px, -40px) rotate(0deg) scale(0.5); opacity: 0; } 20% { opacity: 1; transform: translate(-40px, -20px) rotate(-90deg) scale(1.2); } 30%, 100% { transform: translate(60px, 40px) rotate(-180deg) scale(0.5); opacity: 0; } }
          @keyframes puffDust { 0%, 25% { transform: scale(0); opacity: 0; } 30% { transform: scale(1.2); opacity: 0.8; } 40%, 100% { transform: scale(1.5); opacity: 0; } }
        `}</style>
        <filter id="shadow-sm" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.1" />
        </filter>
        <filter id="shadow-md" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="2" dy="4" stdDeviation="4" floodOpacity="0.15" />
        </filter>
      </defs>

      <g className="anim-float-1">
        <circle cx="80" cy="80" r="10" fill="#e2e8f0" />
        <rect x="310" y="210" width="16" height="16" rx="4" fill="#e2e8f0" transform="rotate(15 318 218)" />
      </g>
      <g className="anim-float-2">
        <polygon points="330,70 315,95 345,95" fill="#f1f5f9" transform="rotate(-20 330 85)" />
        <circle cx="100" cy="230" r="8" fill="#f1f5f9" />
      </g>

      <g className="anim-bin" filter="url(#shadow-md)">
        <path d="M 150 130 L 250 130 L 235 240 C 235 248, 225 250, 215 250 L 185 250 C 175 250, 165 248, 165 240 Z" fill="#cbd5e1" />
        <rect x="175" y="150" width="8" height="80" rx="4" fill="#e2e8f0" />
        <rect x="196" y="150" width="8" height="80" rx="4" fill="#e2e8f0" />
        <rect x="217" y="150" width="8" height="80" rx="4" fill="#e2e8f0" />
      </g>

      <g className="anim-dust">
        <circle cx="180" cy="140" r="15" fill="#e2e8f0" />
        <circle cx="210" cy="135" r="20" fill="#e2e8f0" />
        <circle cx="230" cy="145" r="12" fill="#e2e8f0" />
      </g>

      <g className="anim-paper-1" filter="url(#shadow-sm)">
        <path d="M 120 80 Q 130 70 140 85 Q 150 75 155 90 Q 140 100 130 95 Z" fill="#f43f5e" />
      </g>
      <g className="anim-paper-2" filter="url(#shadow-sm)">
        <path d="M 140 100 Q 150 90 160 110 Q 170 100 175 120 Q 150 130 145 115 Z" fill="#38bdf8" />
      </g>

      <g className="anim-lid" filter="url(#shadow-sm)">
        <rect x="140" y="115" width="120" height="12" rx="6" fill="#94a3b8" />
        <rect x="180" y="105" width="40" height="8" rx="4" fill="#94a3b8" />
      </g>
    </svg>
  );
}
