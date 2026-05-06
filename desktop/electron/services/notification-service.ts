import { Notification } from "electron";
import { randomUUID } from "node:crypto";
import type { BootstrapContext } from "../bootstrap/context.js";
import { broadcastToWindows } from "../bootstrap/context.js";

type NotificationRoute =
  | { kind: "open-window" }
  | { kind: "store-blueprint"; messageId: string | null };

type ActivationArguments = {
  type: "click" | "action" | "reply" | string;
  arguments?: string;
  actionIndex?: number;
  reply?: string;
  userInputs?: Record<string, string>;
};

type NotificationConstructorOptionsWithGrouping =
  Electron.NotificationConstructorOptions & {
    id?: string;
    groupId?: string;
    groupTitle?: string;
  };

type NotificationModuleWithActivation = typeof Notification & {
  handleActivation?: (callback: (details: ActivationArguments) => void) => void;
  getHistory?: () => Promise<Notification[]>;
};

const notificationRoutes = new Map<string, NotificationRoute>();
const liveNotifications = new Set<Notification>();
const notificationModule = Notification as NotificationModuleWithActivation;

const routeFromActivationArguments = (
  args: string | undefined,
): NotificationRoute | null => {
  if (!args) return null;
  for (const [id, route] of notificationRoutes) {
    if (args.includes(id)) return route;
  }
  if (args.includes("store-blueprint")) {
    return { kind: "store-blueprint", messageId: null };
  }
  return null;
};

const activateNotificationRoute = (
  context: BootstrapContext,
  route: NotificationRoute | null,
) => {
  if (!context.state.windowManager) {
    context.state.processRuntime.setManagedTimeout(() => {
      activateNotificationRoute(context, route);
    }, 250);
    return;
  }
  context.state.windowManager.showWindow("full");
  if (route?.kind === "store-blueprint") {
    broadcastToWindows(context, "store:blueprintNotificationActivated", {
      messageId: route.messageId,
    });
  }
};

export const configureNotificationActivationHandling = (
  context: BootstrapContext,
) => {
  if (process.platform === "win32" && notificationModule.handleActivation) {
    notificationModule.handleActivation((details) => {
      activateNotificationRoute(
        context,
        routeFromActivationArguments(details.arguments) ?? {
          kind: "open-window",
        },
      );
    });
  }

  if (process.platform === "darwin" && notificationModule.getHistory) {
    void notificationModule
      .getHistory()
      .then((notifications) => {
        for (const notification of notifications) {
          const route = notificationRoutes.get(notification.id);
          notification.on("click", () =>
            activateNotificationRoute(context, route ?? null),
          );
          liveNotifications.add(notification);
        }
      })
      .catch(() => undefined);
  }
};

export const showStellaNotification = (
  context: BootstrapContext,
  options: NotificationConstructorOptionsWithGrouping,
  route: NotificationRoute = { kind: "open-window" },
) => {
  if (!Notification.isSupported()) return false;

  const id = options.id?.trim() || `stella-${randomUUID()}`;
  notificationRoutes.set(id, route);

  const notification = new Notification({
    ...options,
    id,
  });
  liveNotifications.add(notification);
  notification.on("click", () => activateNotificationRoute(context, route));
  notification.on("action", () => activateNotificationRoute(context, route));
  notification.on("reply", () => activateNotificationRoute(context, route));
  notification.on("close", () => {
    liveNotifications.delete(notification);
  });
  notification.on("failed", (_event, error) => {
    console.warn("Stella notification failed:", error);
  });
  notification.show();
  return true;
};
