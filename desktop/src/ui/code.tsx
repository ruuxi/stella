import * as React from "react";
import { cn } from "@/lib/utils";

export interface CodeProps extends React.HTMLAttributes<HTMLDivElement> {
  language?: string;
}

export const Code = React.forwardRef<HTMLDivElement, CodeProps>(
  ({ className, language, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        data-component="code"
        data-language={language}
        className={cn(className)}
        {...props}
      >
        <pre>
          <code>{children}</code>
        </pre>
      </div>
    );
  }
);

Code.displayName = "Code";
