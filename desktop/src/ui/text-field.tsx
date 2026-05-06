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
  };

type MultilineTextFieldProps = TextFieldBaseProps &
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    multiline: true;
  };

type TextFieldProps = SingleLineTextFieldProps | MultilineTextFieldProps;

export const TextField = React.forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  TextFieldProps
>((props, ref) => {
  const {
    className,
    label,
    hideLabel,
    description,
    error,
    variant = "normal",
    multiline,
    ...fieldProps
  } = props;
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const setForwardedRef = React.useCallback(
    (node: HTMLInputElement | HTMLTextAreaElement | null) => {
      if (!ref) {
        return;
      }
      if (typeof ref === "function") {
        ref(node);
        return;
      }
      ref.current = node;
    },
    [ref],
  );
  const setTextareaRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      setForwardedRef(node);
    },
    [setForwardedRef],
  );
  const textareaValue = multiline
    ? (props.value ?? props.defaultValue)
    : undefined;

  React.useEffect(() => {
    if (!multiline) {
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [multiline, textareaValue]);

  return (
    <div data-component="input" data-variant={variant}>
      {label ? (
        <label
          data-slot="input-label"
          className={hideLabel ? "sr-only" : undefined}
        >
          {label}
        </label>
      ) : null}
      <div data-slot="input-wrapper">
        {multiline ? (
          <textarea
            ref={setTextareaRef}
            data-slot="input-input"
            data-invalid={error ? true : undefined}
            className={cn(className)}
            {...(fieldProps as React.TextareaHTMLAttributes<HTMLTextAreaElement>)}
          />
        ) : (
          <input
            ref={setForwardedRef}
            data-slot="input-input"
            data-invalid={error ? true : undefined}
            className={cn(className)}
            {...(fieldProps as React.InputHTMLAttributes<HTMLInputElement>)}
          />
        )}
      </div>
      {description ? <p data-slot="input-description">{description}</p> : null}
      {error ? <p data-slot="input-error">{error}</p> : null}
    </div>
  );
});

TextField.displayName = "TextField";
