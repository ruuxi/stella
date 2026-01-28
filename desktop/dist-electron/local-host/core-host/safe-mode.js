import { runValidations, smokeValidationSpecs, summarizeValidationResults } from "./validations.js";
export const createSafeModeManager = (options) => {
    const { changeSetManager, stateStore, zoneManager } = options;
    let convexBridge = options.convexBridge ?? null;
    const setConvexBridge = (bridge) => {
        convexBridge = bridge;
    };
    const callMutation = async (name, args) => {
        if (!convexBridge)
            return null;
        try {
            return await convexBridge.callMutation(name, args);
        }
        catch {
            return null;
        }
    };
    const runSmoke = async () => {
        const results = await runValidations(smokeValidationSpecs(zoneManager.projectRoot));
        const summary = summarizeValidationResults(results);
        return { results, summary };
    };
    const runStartupChecks = async () => {
        await stateStore.ensureStructure();
        await changeSetManager.ensureBaseline();
        const lastBoot = await stateStore.getLastBootStatus();
        const safeTrigger = await stateStore.getSafeModeTrigger();
        const boot = await stateStore.startBoot();
        const initialSmoke = await runSmoke();
        // Collect all triggers
        const triggers = [];
        if (safeTrigger?.reason) {
            triggers.push({
                type: "safe_mode_trigger",
                message: `Safe mode was triggered: ${safeTrigger.reason}`,
            });
        }
        if (lastBoot && lastBoot.status !== "healthy") {
            triggers.push({
                type: "unhealthy_boot",
                message: `Previous boot was ${lastBoot.status}`,
            });
        }
        if (!initialSmoke.summary.ok) {
            triggers.push({
                type: "smoke_check_failed",
                message: `Smoke check failed: ${initialSmoke.summary.requiredFailures
                    .map((item) => item.name)
                    .join(", ")}`,
            });
        }
        // If no triggers, mark healthy and return
        if (triggers.length === 0) {
            await stateStore.markBootHealthy(boot.bootId);
            await callMutation("changesets.safe_mode_status", {
                status: "healthy",
                bootId: boot.bootId,
                safeModeApplied: false,
                smokePassed: true,
                checkedAt: Date.now(),
            });
            return {
                needsRevert: false,
                safeModeApplied: false,
                smokePassed: true,
                reason: null,
                smoke: initialSmoke.results,
            };
        }
        // Return trigger info for user confirmation (don't auto-revert)
        const reason = triggers.map((t) => t.message).join(" | ");
        return {
            needsRevert: true,
            triggers,
            reason,
            bootId: boot.bootId,
        };
    };
    const performRevert = async (bootId, reason) => {
        await changeSetManager.rollbackToLastKnownGood(reason);
        if (options.packManager) {
            await options.packManager.disableAllForSafeMode(reason);
        }
        const postRollbackSmoke = await runSmoke();
        const safeModeApplied = true;
        const smokePassed = postRollbackSmoke.summary.ok;
        if (smokePassed) {
            await stateStore.setSafeModeTrigger(null);
            await stateStore.markBootHealthy(bootId);
        }
        else {
            await stateStore.markBootFailed(bootId, reason, safeModeApplied);
        }
        await callMutation("changesets.safe_mode_status", {
            status: smokePassed ? "recovered" : "failed",
            bootId,
            safeModeApplied,
            smokePassed,
            reason,
            checkedAt: Date.now(),
            smokeFailures: postRollbackSmoke.summary.requiredFailures.map((item) => item.name),
        });
        return {
            safeModeApplied,
            smokePassed,
            reason,
            smoke: postRollbackSmoke.results,
        };
    };
    const skipRevert = async (bootId) => {
        // User chose not to revert - mark as healthy anyway and clear triggers
        await stateStore.setSafeModeTrigger(null);
        await stateStore.markBootHealthy(bootId);
        await callMutation("changesets.safe_mode_status", {
            status: "skipped",
            bootId,
            safeModeApplied: false,
            smokePassed: false,
            reason: "User skipped revert",
            checkedAt: Date.now(),
        });
    };
    return {
        setConvexBridge,
        runStartupChecks,
        performRevert,
        skipRevert,
    };
};
