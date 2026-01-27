import path from "path";
import { createZoneManager } from "./zone-config.js";
import { createInstructionManager } from "./instructions.js";
import { StateStore } from "./state-store.js";
import { createChangeSetManager, type ConvexBridge } from "./change-sets.js";
import { createPackManager } from "./packs.js";
import { createUpdateManager } from "./updates.js";
import { createSafeModeManager } from "./safe-mode.js";

type CoreHostOptions = {
  deviceId: string;
  projectRoot: string;
  stellarHome: string;
  convexBridge?: ConvexBridge | null;
};

export const createCoreHost = (options: CoreHostOptions) => {
  const zoneManager = createZoneManager({
    projectRoot: options.projectRoot,
    stellarHome: options.stellarHome,
  });

  const stateStore = new StateStore({
    stateRoot: path.join(options.stellarHome, "state"),
    packsRoot: path.join(options.stellarHome, "packs"),
  });

  const instructionManager = createInstructionManager(zoneManager);
  const changeSetManager = createChangeSetManager({
    zoneManager,
    instructionManager,
    stateStore,
    convexBridge: options.convexBridge ?? null,
  });

  const packManager = createPackManager({
    deviceId: options.deviceId,
    zoneManager,
    instructionManager,
    stateStore,
    changeSetManager,
    convexBridge: options.convexBridge ?? null,
  });

  const updateManager = createUpdateManager({
    zoneManager,
    instructionManager,
    stateStore,
    changeSetManager,
    convexBridge: options.convexBridge ?? null,
  });

  const safeModeManager = createSafeModeManager({
    changeSetManager,
    stateStore,
    zoneManager,
    packManager,
    convexBridge: options.convexBridge ?? null,
  });

  const setConvexBridge = (bridge: ConvexBridge | null) => {
    changeSetManager.setConvexBridge(bridge);
    packManager.setConvexBridge(bridge);
    updateManager.setConvexBridge(bridge);
    safeModeManager.setConvexBridge(bridge);
  };

  const ensureSelfModChangeSet = async (context: {
    agentType: string;
    conversationId?: string;
    deviceId: string;
  }) => {
    if (context.agentType !== "self_mod") {
      return null;
    }
    const active = await changeSetManager.startChangeSet({
      scope: "self_mod",
      agentType: context.agentType,
      conversationId: context.conversationId,
      deviceId: context.deviceId,
      reason: "Auto-start ChangeSet for self-modification.",
    });
    return active.id;
  };

  return {
    zoneManager,
    instructionManager,
    stateStore,
    changeSetManager,
    packManager,
    updateManager,
    safeModeManager,
    setConvexBridge,
    ensureSelfModChangeSet,
  };
};

export type CoreHost = ReturnType<typeof createCoreHost>;

