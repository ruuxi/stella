import { useEffect } from "react";
import { getElectronApi } from "../../services/electron";
import { useScreenCommandBus } from "./screen-command-bus";
import type {
  ScreenInvokeRequest,
  ScreenInvokeResult,
  ScreenListRequest,
  ScreenListResult,
} from "./screen-types";

const toInvokeResult = (
  request: ScreenInvokeRequest,
  outcome: ScreenInvokeResult,
): ScreenInvokeResult => ({
  requestId: request.requestId,
  ok: outcome.ok,
  result: outcome.result,
  error: outcome.error,
});

export const ScreenIpcBridge = () => {
  const bus = useScreenCommandBus();

  useEffect(() => {
    const electronApi = getElectronApi();
    if (!electronApi?.onScreenInvoke || !electronApi.respondScreenInvoke) {
      return;
    }

    const unsubscribeInvoke = electronApi.onScreenInvoke((request: ScreenInvokeRequest) => {
      void bus
        .invoke(request.screenId, request.command, request.args, {
          requestId: request.requestId,
          conversationId: request.conversationId,
          deviceId: request.deviceId,
        })
        .then((outcome) => {
          electronApi.respondScreenInvoke(toInvokeResult(request, outcome));
        })
        .catch((error) => {
          electronApi.respondScreenInvoke({
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : "Screen command failed.",
          });
        });
    });

    const unsubscribeList = electronApi.onScreenListRequest?.((request: ScreenListRequest) => {
      const result: ScreenListResult = {
        requestId: request.requestId,
        ok: true,
        screens: bus.listScreens(),
      };
      electronApi.respondScreenList?.(result);
    });

    return () => {
      unsubscribeInvoke();
      unsubscribeList?.();
    };
  }, [bus]);

  return null;
};

