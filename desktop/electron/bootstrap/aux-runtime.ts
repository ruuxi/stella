import { getDevServerUrl } from "../dev-url.js";
import { buildMobileBridgeBootstrap } from "../services/mobile-bridge/bootstrap-payload.js";
import { createStellaBrowserBridgeResource } from "../process-resources/browser-bridge-resource.js";
import { createMobileBridgeResource } from "../process-resources/mobile-bridge-resource.js";
import {
  type BootstrapContext,
  broadcastStellaBrowserBridgeStatus,
} from "./context.js";

const readMobileBridgeBootstrap = async (context: BootstrapContext) => {
  const window = context.state.windowManager?.getFullWindow();
  if (!window || window.isDestroyed()) {
    return buildMobileBridgeBootstrap({});
  }

  try {
    const raw = await window.webContents.executeJavaScript(
      `(()=>{var d={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k!==null)d[k]=localStorage.getItem(k)}return JSON.stringify(d)})()`,
    );
    return buildMobileBridgeBootstrap(JSON.parse(raw as string));
  } catch {
    return buildMobileBridgeBootstrap({});
  }
};

export const startMobileBridge = (context: BootstrapContext) => {
  try {
    if (context.state.mobileBridgeResource) {
      context.state.mobileBridgeResource.start();
      return;
    }

    const resource = createMobileBridgeResource({
      electronDir: context.config.electronDir,
      isDev: context.config.isDev,
      getAuthToken: () => context.services.authService.getAuthToken(),
      getBootstrapPayload: () => readMobileBridgeBootstrap(context),
      getConvexSiteUrl: () => context.services.authService.getConvexSiteUrl(),
      getDeviceId: () => context.state.deviceId,
      getDevServerUrl: () => getDevServerUrl() ?? "",
      getFullWindow: () => context.state.windowManager?.getFullWindow() ?? null,
      processRuntime: context.state.processRuntime,
    });

    context.state.mobileBridgeResource = resource;
    resource.start();
  } catch (error) {
    console.error(
      "[mobile-bridge] Failed to start:",
      (error as Error).message,
    );
  }
};

export const startStellaBrowserBridge = (context: BootstrapContext) => {
  if (context.state.stellaBrowserBridgeService) {
    context.state.stellaBrowserBridgeService.start();
    return;
  }

  const service = createStellaBrowserBridgeResource({
    frontendRoot: context.config.frontendRoot,
    processRuntime: context.state.processRuntime,
    onStatus: (status) => {
      broadcastStellaBrowserBridgeStatus(context, status);
    },
  });

  context.state.stellaBrowserBridgeService = service;
  service.start();
};
