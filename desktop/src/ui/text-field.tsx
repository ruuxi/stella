import * as React from "react";
import { cn } from "@/shared/lib/utils";

type TextFieldBaseProps = {
  label?: string;
  hideLabel?: boolean;
  description?: string;
  error?: string;
  variant?: "normal" | "ghost";
};

type SingleLineTextFieldProps = TextFieldBaseProps &
  React.InputHTMLAttributes<HTMLInputElement> & {
    multiline?: false;
    textareaProps?: never;
  };

type MultilineTextFieldProps = TextFieldBaseProps &
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    multiline: true;
  textareaProps?: React.TextareaHTMLAttributes<HTMLTextAreaElement>;
  };

export type TextFieldProps = SingleLineTextFieldProps | MultilineTextFieldProps;

export const TextField = React.forwardRef<HTMLInputElement | HTMLTextAreaElement, TextFieldProps>(
  (props, ref) => {
    const {
      className,
      label,
      hideLabel,
      description,
      error,
      variant = "normal",
      multiline,
    } = props;
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const setTextareaRef = React.useCallback((node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;

      if (!ref) return;
      if (typeof ref === "function") {
        ref(node);
        return;
      }
      ref.current = node;
    }, [ref]);

    // Auto-resize textarea
    React.useEffect(() => {
      if (multiline && textareaRef.current) {
        const textarea = textareaRef.current;
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;
      }
    }, [multiline, props.textareaProps?.value, multiline ? props.value : undefined]);

    return (
      <div data-component="input" data-variant={variant}>
        {label && (
          <label data-slot="input-label" className={hideLabel ? "sr-only" : undefined}>
            {label}
          </label>
        )}
        <div data-slot="input-wrapper">
          {multiline ? (() => {
            const {
              label: _label,
              hideLabel: _hideLabel,
              description: _description,
              error: _error,
              variant: _variant,
              multiline: _multiline,
              textareaProps,
              ...textareaOnlyProps
            } = props as MultilineTextFieldProps;

            return (
              <textarea
                ref={setTextareaRef}
                data-slot="input-input"
                data-invalid={error ? true : undefined}
                className={cn(className)}
                {...textareaOnlyProps}
                {...textareaProps}
              />
            );
          })() : (() => {
            const {
              label: _label,
              hideLabel: _hideLabel,
              description: _description,
              error: _error,
              variant: _variant,
              multiline: _multiline,
              textareaProps: _textareaProps,
              ...inputOnlyProps
            } = props as SingleLineTextFieldProps;

            return (
              <input
                ref={ref as React.Ref<HTMLInputElement>}
                data-slot="input-input"
                data-invalid={error ? true : undefined}
                className={cn(className)}
                {...inputOnlyProps}
              />
            );
          })()}
        </div>
        {description && <p data-slot="input-description">{description}</p>}
        {error && <p data-slot="input-error">{error}</p>}
      </div>
    );
  }
);

TextField.displayName = "TextField";
