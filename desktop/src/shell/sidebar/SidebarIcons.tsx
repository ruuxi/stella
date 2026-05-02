import * as React from "react";

interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
}

export const CustomHouse = ({ size = 18, className = "", ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`custom-icon icon-house ${className}`} {...props}>
    <path className="house-roof" d="M3 10l9-7 9 7" />
    <path className="house-base" d="M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10" />
  </svg>
);

export const CustomUsers = ({ size = 18, className = "", ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`custom-icon icon-users ${className}`} {...props}>
    <path className="users-p1" d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
    <circle className="users-p1" cx="9" cy="7" r="4" />
    <path className="users-p2" d="M22 21v-2a4 4 0 00-3-3.87" />
    <path className="users-p2" d="M16 3.13a4 4 0 010 7.75" />
  </svg>
);

export const CustomLayout = ({ size = 18, className = "", ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`custom-icon icon-layout ${className}`} {...props}>
    <rect className="layout-r1" x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <path className="layout-r2" d="M3 9h18" />
    <path className="layout-r3" d="M9 21V9" />
  </svg>
);

export const CustomPlusSquare = ({ size = 18, className = "", ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`custom-icon icon-plus-square ${className}`} {...props}>
    <rect className="plus-sq-r" x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <path className="plus-sq-p" d="M12 8v8M8 12h8" />
  </svg>
);

export const CustomSettings = ({ size = 18, className = "", ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`custom-icon icon-settings ${className}`} {...props}>
    <circle className="set-c" cx="12" cy="12" r="3" />
    <path className="set-p" d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
  </svg>
);

export const CustomStore = ({ size = 18, className = "", ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`custom-icon icon-store ${className}`} {...props}>
    <path className="store-bag" d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
    <line className="store-line" x1="3" y1="6" x2="21" y2="6" />
    <path className="store-handle" d="M16 10a4 4 0 01-8 0" />
  </svg>
);

export const CustomDevice = ({ size = 18, className = "", ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`custom-icon icon-device ${className}`} {...props}>
    <g className="device-body-group">
      <rect x="3" y="3" width="12" height="18" rx="2" ry="2" />
      <path d="M7 18h4" />
    </g>
    <path className="device-wave-1" d="M17 8.5a5 5 0 0 1 0 7" />
    <path className="device-wave-2" d="M20 5.5a9 9 0 0 1 0 13" />
  </svg>
);

export const CustomLogIn = ({ size = 18, className = "", ...props }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`custom-icon icon-login ${className}`} {...props}>
    <path className="li-p1" d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4" />
    <path className="li-p2" d="M10 17l5-5-5-5" />
    <path className="li-p3" d="M15 12H3" />
  </svg>
);
