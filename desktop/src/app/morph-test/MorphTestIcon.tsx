import type { ComponentType, SVGProps } from "react";

const MorphTestIcon: ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
> = ({ size = 18, className = "", ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`custom-icon icon-morph-test ${className}`}
    {...props}
  >
    <circle cx="12" cy="12" r="3" />
    <circle cx="12" cy="12" r="7" opacity="0.55" />
    <circle cx="12" cy="12" r="10.5" opacity="0.25" />
  </svg>
);

export default MorphTestIcon;
