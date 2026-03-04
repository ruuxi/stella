import * as React from "react";
import { cn } from "@/lib/utils";

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "primary" | "success" | "warning" | "error" | "info";
  size?: "small" | "normal";
}

export const Tag = React.forwardRef<HTMLSpanElement, TagProps>(
  ({ className, variant = "default", size = "normal", children, ...props }, ref) => {
    return (
      <span
        ref={ref}
        data-component="tag"
        data-variant={variant}
        data-size={size}
        className={cn(className)}
        {...props}
      >
        {children}
      </span>
    );
  }
);

Tag.displayName = "Tag";
