import * as React from "react";
import { cn } from "@/lib/utils";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "normal" | "error" | "warning" | "success" | "info";
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant = "normal", children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-component="card"
        data-variant={variant}
        className={cn(className)}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = "Card";
