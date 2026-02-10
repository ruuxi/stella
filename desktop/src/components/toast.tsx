/* eslint-disable react-refresh/only-export-components */
import * as React from "react";
import { X } from "lucide-react";

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
}

export interface ToastOptions {
  title?: string;
  description?: string;
  variant?: "default" | "success" | "error" | "loading";
  duration?: number;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const addToast = React.useCallback((options: ToastOptions) => {
    const id = Math.random().toString(36).substring(2, 9);
    const toast: Toast = { id, ...options };
    setToasts((prev) => [...prev, toast]);

    if (options.duration !== 0) {
      const timeout = options.duration || 5000;
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, timeout);
    }

    return id;
  }, []);

  const removeToast = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastRegion />
    </ToastContext.Provider>
  );
}

function ToastRegion() {
  const { toasts, removeToast } = useToast();

  return (
    <div data-component="toast-region">
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
  return (
    <li data-component="toast" data-variant={toast.variant || "default"}>
      <div data-slot="toast-content">
        {toast.title && <div data-slot="toast-title">{toast.title}</div>}
        {toast.description && <div data-slot="toast-description">{toast.description}</div>}
      </div>
      <button data-slot="toast-close-button" onClick={onClose} type="button">
        <X size={16} />
      </button>
    </li>
  );
}

let toastFn: ((options: ToastOptions | string) => string) | null = null;

export function setToastFn(fn: (options: ToastOptions | string) => string) {
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
