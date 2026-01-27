import type { ChangeSetManager } from "./change-sets.js";
import type { StateStore } from "./state-store.js";
import type { ZoneManager } from "./zone-config.js";
import { runValidations, smokeValidationSpecs, summarizeValidationResults } from "./validations.js";
import type { ConvexBridge } from "./change-sets.js";

type SafeModeOptions = {
  changeSetManager: ChangeSetManager;
  stateStore: StateStore;
  zoneManager: ZoneManager;
  packManager?: {
    disableAllForSafeMode: (reason: string) => Promise<void>;
  } | null;
  convexBridge?: ConvexBridge | null;
};

export const createSafeModeManager = (options: SafeModeOptions) => {
  const { changeSetManager, stateStore, zoneManager } = options;
  let convexBridge = options.convexBridge ?? null;

  const setConvexBridge = (bridge: ConvexBridge | null) => {
    convexBridge = bridge;
  };

  const callMutation = async (name: string, args: Record<string, unknown>) => {
    if (!convexBridge) return null;
    try {
      return await convexBridge.callMutation(name, args);
    } catch {
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

    const needsSafeMode =
      Boolean(safeTrigger) || (lastBoot ? lastBoot.status !== "healthy" : false);

    const initialSmoke = await runSmoke();
    if (!needsSafeMode && initialSmoke.summary.ok) {
      await stateStore.markBootHealthy(boot.bootId);
      await callMutation("changesets.safe_mode_status", {
        status: "healthy",
        bootId: boot.bootId,
        safeModeApplied: false,
        smokePassed: true,
        checkedAt: Date.now(),
      });
      return {
        safeModeApplied: false,
        smokePassed: true,
        reason: null,
        smoke: initialSmoke.results,
      };
    }

    const reasonParts: string[] = [];
    if (safeTrigger?.reason) {
      reasonParts.push(safeTrigger.reason);
    }
    if (!initialSmoke.summary.ok) {
      reasonParts.push(
        `Smoke check failed: ${initialSmoke.summary.requiredFailures
          .map((item) => item.name)
          .join(", ")}`,
      );
    }
    if (lastBoot && lastBoot.status !== "healthy") {
      reasonParts.push(`Previous boot was ${lastBoot.status}.`);
    }
    const reason = reasonParts.join(" | ") || "Startup health check failed.";

    await changeSetManager.rollbackToLastKnownGood(reason);
    if (options.packManager) {
      await options.packManager.disableAllForSafeMode(reason);
    }

    const postRollbackSmoke = await runSmoke();
    const safeModeApplied = true;
    const smokePassed = postRollbackSmoke.summary.ok;

    if (smokePassed) {
      await stateStore.setSafeModeTrigger(null);
      await stateStore.markBootHealthy(boot.bootId);
    } else {
      await stateStore.markBootFailed(boot.bootId, reason, safeModeApplied);
    }

    await callMutation("changesets.safe_mode_status", {
      status: smokePassed ? "recovered" : "failed",
      bootId: boot.bootId,
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

  return {
    setConvexBridge,
    runStartupChecks,
  };
};

export type SafeModeManager = ReturnType<typeof createSafeModeManager>;

