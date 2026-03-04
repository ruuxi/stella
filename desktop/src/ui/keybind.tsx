import * as React from "react";
import { cn } from "@/lib/utils";

export interface KeybindProps extends React.HTMLAttributes<HTMLSpanElement> {
  keys: string | string[];
}

export const Keybind = React.forwardRef<HTMLSpanElement, KeybindProps>(
  ({ className, keys, ...props }, ref) => {
    const keyArray = Array.isArray(keys) ? keys : [keys];

    return (
      <span
        ref={ref}
        data-component="keybind"
        className={cn(className)}
        {...props}
      >
        {keyArray.map((key, index) => (
          <React.Fragment key={index}>
            <kbd data-slot="keybind-key">{key}</kbd>
            {index < keyArray.length - 1 && (
              <span data-slot="keybind-separator">+</span>
            )}
          </React.Fragment>
        ))}
      </span>
    );
  }
);

Keybind.displayName = "Keybind";
