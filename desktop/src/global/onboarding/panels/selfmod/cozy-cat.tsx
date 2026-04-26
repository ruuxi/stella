/* eslint-disable */
/**
 * Cozy mode tuxedo cat illustrations — mirrors the desktop StellaAppMock
 * cozy-cat character so the website's self-mod "High" stage feels like
 * the same personalization moment the user gets in onboarding.
 *
 * Hand-drawn so the demo reads as personal and "drastic" — a true vibe
 * shift rather than another utilitarian variation.
 */

export function CozyCatAvatar() {
  return (
    <svg viewBox="0 0 32 32" fill="#1c1c1c" aria-hidden="true">
      <ellipse cx="16" cy="20" rx="11" ry="9" />
      <path d="M9 12 L7 4 L14 11 Z" />
      <path d="M23 12 L25 4 L18 11 Z" />
      <ellipse cx="16" cy="22" rx="6" ry="4.5" fill="white" />
      <path d="M11 18 Q12 16 13 18" stroke="white" strokeWidth="1" fill="none" strokeLinecap="round" />
      <path d="M19 18 Q20 16 21 18" stroke="white" strokeWidth="1" fill="none" strokeLinecap="round" />
      <path d="M14.5 21 L17.5 21 L16 22.5 Z" fill="#e89a98" />
    </svg>
  );
}

/**
 * Sleeping tuxedo cat ("Mochi") — sits in the cozy widget at the bottom
 * of the self-mod shell. The tail and body have separate <g> wrappers
 * so CSS can animate them independently (breathing + tail sway).
 */
export function CozyCat() {
  return (
    <svg viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g className="selfmod-cozy-cat-tail">
        <path
          d="M104 60 Q120 52 115 36 Q108 22 90 27"
          stroke="#1c1c1c"
          strokeWidth="9"
          fill="none"
          strokeLinecap="round"
        />
        <ellipse
          cx="92"
          cy="27"
          rx="5.5"
          ry="4"
          fill="white"
          transform="rotate(18 92 27)"
        />
      </g>

      <g className="selfmod-cozy-cat-body">
        <path
          d="M14 56 Q14 36 40 31 Q60 26 80 31 Q106 36 106 56 L106 70 Q106 75 101 75 L19 75 Q14 75 14 70 Z"
          fill="#1c1c1c"
        />
        <path
          d="M44 56 Q60 51 76 56 L73 74 Q60 76 47 74 Z"
          fill="white"
        />

        <ellipse cx="50" cy="32" rx="18" ry="16" fill="#1c1c1c" />
        <path
          d="M40 35 Q40 48 50 50 Q60 48 60 35 Q55 32 50 32 Q45 32 40 35 Z"
          fill="white"
        />

        <path d="M37 22 L33 10 L46 20 Z" fill="#1c1c1c" />
        <path d="M63 22 L67 10 L54 20 Z" fill="#1c1c1c" />
        <path d="M38 20 L36 13 L43 19 Z" fill="#f4b8b0" />
        <path d="M62 20 L64 13 L57 19 Z" fill="#f4b8b0" />

        <path
          d="M42 36 Q44 33.5 46 36"
          stroke="#1c1c1c"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
        />
        <path
          d="M54 36 Q56 33.5 58 36"
          stroke="#1c1c1c"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
        />

        <path d="M48 41 L52 41 L50 43.4 Z" fill="#e89a98" />
        <path
          d="M50 43.4 Q48 45.4 46 44.6 M50 43.4 Q52 45.4 54 44.6"
          stroke="#1c1c1c"
          strokeWidth="0.8"
          fill="none"
          strokeLinecap="round"
        />

        <line x1="35" y1="40" x2="44" y2="41" stroke="#1c1c1c" strokeWidth="0.5" />
        <line x1="35" y1="42.5" x2="44" y2="42" stroke="#1c1c1c" strokeWidth="0.5" />
        <line x1="56" y1="41" x2="65" y2="40" stroke="#1c1c1c" strokeWidth="0.5" />
        <line x1="56" y1="42" x2="65" y2="42.5" stroke="#1c1c1c" strokeWidth="0.5" />

        <ellipse cx="36" cy="73" rx="6.5" ry="3" fill="white" />
        <ellipse cx="64" cy="73" rx="6.5" ry="3" fill="white" />
        <line x1="33.5" y1="71.5" x2="33.5" y2="74" stroke="#cfcfcf" strokeWidth="0.5" />
        <line x1="36" y1="71" x2="36" y2="74.5" stroke="#cfcfcf" strokeWidth="0.5" />
        <line x1="38.5" y1="71.5" x2="38.5" y2="74" stroke="#cfcfcf" strokeWidth="0.5" />
        <line x1="61.5" y1="71.5" x2="61.5" y2="74" stroke="#cfcfcf" strokeWidth="0.5" />
        <line x1="64" y1="71" x2="64" y2="74.5" stroke="#cfcfcf" strokeWidth="0.5" />
        <line x1="66.5" y1="71.5" x2="66.5" y2="74" stroke="#cfcfcf" strokeWidth="0.5" />
      </g>
    </svg>
  );
}

/**
 * Cozy widget shown at the bottom of the self-mod shell when the
 * "High" stage is active. Replaces the in-window paw decoration with
 * a sleeping Mochi + purring status + heartbeat meter — the same
 * personalization beat the desktop onboarding shows.
 */
export function CozyWidget() {
  return (
    <div className="selfmod-cozy" aria-hidden="true">
      <div className="selfmod-cozy-cat">
        <span className="selfmod-cozy-zzz selfmod-cozy-zzz-1">z</span>
        <span className="selfmod-cozy-zzz selfmod-cozy-zzz-2">z</span>
        <span className="selfmod-cozy-zzz selfmod-cozy-zzz-3">Z</span>
        <CozyCat />
      </div>
      <div className="selfmod-cozy-meta">
        <div className="selfmod-cozy-state">
          <span className="selfmod-cozy-state-dot" />
          Cozy mode &middot; purring
        </div>
        <div className="selfmod-cozy-line">
          Mochi is curled up beside you.
        </div>
      </div>
      <div className="selfmod-cozy-meter">
        <span className="selfmod-cozy-heart">{"\u2665"}</span>
        <span>2h 14m</span>
      </div>
    </div>
  );
}
