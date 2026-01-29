import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: "small" | "normal" | "large";
  variant?: "primary" | "secondary" | "ghost";
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "normal", children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        data-component="button"
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

Button.displayName = "Button";
