import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hideLabel?: boolean;
  description?: string;
  error?: string;
  variant?: "normal" | "ghost";
  multiline?: boolean;
  textareaProps?: React.TextareaHTMLAttributes<HTMLTextAreaElement>;
}

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  (
    {
      className,
      label,
      hideLabel,
      description,
      error,
      variant = "normal",
      multiline,
      textareaProps,
      ...props
    },
    ref
  ) => {
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);

    // Auto-resize textarea
    React.useEffect(() => {
      if (multiline && textareaRef.current) {
        const textarea = textareaRef.current;
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;
      }
    }, [multiline, textareaProps?.value]);

    return (
      <div data-component="input" data-variant={variant}>
        {label && (
          <label data-slot="input-label" className={hideLabel ? "sr-only" : undefined}>
            {label}
          </label>
        )}
        <div data-slot="input-wrapper">
          {multiline ? (
            <textarea
              ref={textareaRef}
              data-slot="input-input"
              data-invalid={error ? true : undefined}
              className={cn(className)}
              {...textareaProps}
            />
          ) : (
            <input
              ref={ref}
              data-slot="input-input"
              data-invalid={error ? true : undefined}
              className={cn(className)}
              {...props}
            />
          )}
        </div>
        {description && <p data-slot="input-description">{description}</p>}
        {error && <p data-slot="input-error">{error}</p>}
      </div>
    );
  }
);

TextField.displayName = "TextField";
