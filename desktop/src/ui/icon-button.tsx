import * as React from "react";
import { cn } from "@/lib/utils";

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: "normal" | "large";
  variant?: "primary" | "secondary" | "ghost";
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant = "secondary", size = "normal", children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        data-component="icon-button"
        data-size={size}
        data-variant={variant}
        className={cn(className)}
        {...props}
      >
        {children}
      </button>
    );
  }
);

IconButton.displayName = "IconButton";
