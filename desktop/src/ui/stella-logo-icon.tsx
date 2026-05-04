import type { ImgHTMLAttributes } from "react";

type StellaLogoIconProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "width" | "height"
> & {
  size?: number;
};

export function StellaLogoIcon({
  size = 16,
  style,
  alt = "",
  ...props
}: StellaLogoIconProps) {
  return (
    <img
      src="stella-logo.svg"
      alt={alt}
      width={size}
      height={size}
      style={{
        display: "inline-block",
        flex: "0 0 auto",
        objectFit: "contain",
        verticalAlign: "middle",
        ...style,
      }}
      {...props}
    />
  );
}
