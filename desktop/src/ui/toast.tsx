import * as React from "react";
import { X } from "lucide-react";
import { NativeWebsiteOverlayRegistrar } from "@/shared/lib/native-website-overlay";

interface ToastContextValue {
  toasts: Toast[];
  addToast: (options: ToastOptions) => string;
  removeToast: (id: string) => void;
}

interface Toast {
  id: string;
  title?: string;
  description?: string;
  variant?: "default" | "success" | "error" | "loading";
  duration?: number;
  action?: ToastAction;
  secondaryAction?: ToastAction;
}

type ToastAction = {
  label: string;
  onClick: () => void;
};

export interface ToastOptions {
  title?: string;
  description?: string;
  variant?: "default" | "success" | "error" | "loading";
  duration?: number;
  action?: ToastAction;
  /** Optional secondary CTA rendered next to `action` (e.g. "Use my own key"). */
  secondaryAction?: ToastAction;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

function useToast() {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const toastTimeoutsRef = React.useRef(new Map<string, number>());

  const removeToast = React.useCallback((id: string) => {
    const timeoutId = toastTimeoutsRef.current.get(id);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      toastTimeoutsRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = React.useCallback((options: ToastOptions) => {
    const id = Math.random().toString(36).substring(2, 9);
    const toast: Toast = { id, ...options };
    setToasts((prev) => [...prev, toast]);

    if (options.duration !== 0) {
      const timeout = options.duration || 4000;
      const timeoutId = window.setTimeout(() => {
        removeToast(id);
      }, timeout);
      toastTimeoutsRef.current.set(id, timeoutId);
    }

    return id;
  }, [removeToast]);

  React.useEffect(() => {
    const toastTimeouts = toastTimeoutsRef.current;

    return () => {
      for (const timeoutId of toastTimeouts.values()) {
        window.clearTimeout(timeoutId);
      }
      toastTimeouts.clear();
    };
  }, []);

  const value = React.useMemo(
    () => ({ toasts, addToast, removeToast }),
    [toasts, addToast, removeToast],
  );

  React.useEffect(() => {
    const imperativeToast = (options: ToastOptions | string) =>
      addToast(typeof options === "string" ? { description: options } : options);

    setToastFn(imperativeToast);
    if (typeof window !== "undefined") {
      (window as unknown as { showToast?: typeof showToast }).showToast = showToast;
    }

    return () => {
      if (toastFn === imperativeToast) {
        setToastFn(null);
      }
    };
  }, [addToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastRegion />
    </ToastContext.Provider>
  );
}

function ToastRegion() {
  const { toasts, removeToast } = useToast();

  return (
    <div data-component="toast-region">
      {toasts.length > 0 ? <NativeWebsiteOverlayRegistrar /> : null}
      <ul data-slot="toast-list">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
        ))}
      </ul>
    </div>
  );
}

interface ToastItemProps {
  toast: Toast;
  onClose: () => void;
}

function ToastItem({ toast, onClose }: ToastItemProps) {
  const handleActionClick = React.useCallback(() => {
    toast.action?.onClick();
    onClose();
  }, [onClose, toast.action]);
  const handleSecondaryActionClick = React.useCallback(() => {
    toast.secondaryAction?.onClick();
    onClose();
  }, [onClose, toast.secondaryAction]);

  return (
    <li data-component="toast" data-variant={toast.variant}>
      <div data-slot="toast-content">
        {toast.title && <div data-slot="toast-title">{toast.title}</div>}
        {toast.description && <div data-slot="toast-description">{toast.description}</div>}
        {(toast.action || toast.secondaryAction) && (
          <div data-slot="toast-actions">
            {toast.action && (
              <button
                data-slot="toast-action-button"
                onClick={handleActionClick}
                type="button"
              >
                {toast.action.label}
              </button>
            )}
            {toast.secondaryAction && (
              <button
                data-slot="toast-action-button"
                data-variant="secondary"
                onClick={handleSecondaryActionClick}
                type="button"
              >
                {toast.secondaryAction.label}
              </button>
            )}
          </div>
        )}
      </div>
      <button data-slot="toast-close-button" onClick={onClose} type="button">
        <X size={16} />
      </button>
    </li>
  );
}

let toastFn: ((options: ToastOptions | string) => string) | null = null;

function setToastFn(fn: ((options: ToastOptions | string) => string) | null) {
  toastFn = fn;
}

export function showToast(options: ToastOptions | string): string {
  if (!toastFn) {
    console.warn("Toast provider not initialized");
    return "";
  }
  const opts = typeof options === "string" ? { description: options } : options;
  return toastFn(opts);
}

// Window hook so we can fire toasts from the DevTools console while
// iterating on copy / styling.
if (typeof window !== "undefined") {
  (window as unknown as { showToast?: typeof showToast }).showToast = showToast;
}
