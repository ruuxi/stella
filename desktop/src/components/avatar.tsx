import * as React from "react";
import { cn } from "@/lib/utils";

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  fallback: string;
  src?: string;
  background?: string;
  foreground?: string;
  size?: "small" | "normal" | "large";
}

export const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  (
    { className, fallback, src, background, foreground, size = "normal", style, ...props },
    ref
  ) => {
    const customStyle: React.CSSProperties = {
      ...style,
      ...((!src && background) ? { "--avatar-bg": background } as React.CSSProperties : {}),
      ...((!src && foreground) ? { "--avatar-fg": foreground } as React.CSSProperties : {}),
    };

    return (
      <div
        ref={ref}
        data-component="avatar"
        data-size={size}
        data-has-image={src ? "" : undefined}
        className={cn(className)}
        style={customStyle}
        {...props}
      >
        {src ? (
          <img
            src={src}
            draggable={false}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              borderRadius: "inherit",
            }}
          />
        ) : (
          fallback?.[0]
        )}
      </div>
    );
  }
);

Avatar.displayName = "Avatar";
