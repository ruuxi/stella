import path from "path";
import { createZoneManager } from "./zone-config.js";
import { createInstructionManager } from "./instructions.js";
import { StateStore } from "./state-store.js";
import { createChangeSetManager } from "./change-sets.js";
import { createPackManager } from "./packs.js";
import { createUpdateManager } from "./updates.js";
import { createSafeModeManager } from "./safe-mode.js";
export const createCoreHost = (options) => {
    const zoneManager = createZoneManager({
        projectRoot: options.projectRoot,
        StellaHome: options.stellaHome,
    });
    const stateStore = new StateStore({
        stateRoot: path.join(options.stellaHome, "state"),
        packsRoot: path.join(options.stellaHome, "packs"),
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
    const setConvexBridge = (bridge) => {
        changeSetManager.setConvexBridge(bridge);
        packManager.setConvexBridge(bridge);
        updateManager.setConvexBridge(bridge);
        safeModeManager.setConvexBridge(bridge);
    };
    const ensureSelfModChangeSet = async (context) => {
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
