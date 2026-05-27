/**
 * Developer-only IPC for the in-app morph test scratchpad.
 *
 * The morph-test app (`desktop/src/app/morph-test/`) drives two things:
 *
 *  1. `morphTest:setPreferredFlavor` flips the overlay's HMR-flavor
 *     override between the original ripple morph and a glimm-style
 *     band sweep. The override is consumed by
 *     `OverlayWindowController.startMorphForward` for any subsequent
 *     self-mod transition.
 *
 *  2. `morphTest:triggerSelfMod` fires a real external self-mod run by
 *     toggling a visible test feature. The chosen files decide which apply
 *     path the runtime walks:
 *       - `hmr`     → `desktop/src/app/morph-test/scratch.ts`
 *                     (renderer HMR only).
 *       - `reload`  → scratch + `desktop/src/app/morph-test/metadata.ts`
 *                     (HMR + full window reload, escalated to reload).
 *       - `restart` → scratch + metadata + `desktop/electron/_morph_test_scratch.ts`
 *                     (HMR + reload + full Electron process restart, escalated
 *                     to process restart).
 *
 *     All scenarios route through the same
 *     `beginExternalSelfMod` / `finishExternalSelfMod` pair the
 *     install-update flow uses (see `updates-handlers.ts`) so the test covers
 *     the real tier escalation behavior.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  IPC_MORPH_TEST_GET_TIMING_SETTINGS,
  IPC_MORPH_TEST_MEASURE_CAPTURE,
  IPC_MORPH_TEST_RESET_TIMING_SETTINGS,
  IPC_MORPH_TEST_SET_PREFERRED_FLAVOR,
  IPC_MORPH_TEST_SET_TIMING_SETTINGS,
  IPC_MORPH_TEST_TRIGGER_SELF_MOD,
} from "../../src/shared/contracts/ipc-channels.js";
import {
  captureWindowDataUrl,
} from "../windows/morph-transition-helpers.js";
import {
  DEFAULT_MORPH_TIMING_SETTINGS,
  type MorphTimingSettings,
  type MorphTimingTierSettings,
} from "../../src/shared/contracts/morph-timing.js";
import type { OverlayWindowController } from "../windows/overlay-window.js";
import type { StellaHostRunner } from "../stella-host-runner.js";

export type MorphTestScenario = "hmr" | "reload" | "restart";

export type MorphTestPreferredFlavor = "ripple" | "glimm";

export type MorphCaptureMeasurement = {
  index: number;
  ok: boolean;
  capturePageMs: number;
  totalDataUrlMs: number;
  dataUrlBytes: number;
};

export type MorphCaptureBenchmarkResult = {
  ok: boolean;
  samples: MorphCaptureMeasurement[];
  summary: {
    count: number;
    capturePageAvgMs: number;
    capturePageMinMs: number;
    capturePageMaxMs: number;
    totalDataUrlAvgMs: number;
    totalDataUrlMinMs: number;
    totalDataUrlMaxMs: number;
    avgDataUrlBytes: number;
  };
};

const clampTiming = (
  value: unknown,
  fallback: number,
  min = 0,
  max = 10_000,
): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;

const normalizeTimingTier = (
  value: Partial<MorphTimingTierSettings> | undefined,
  fallback: MorphTimingTierSettings,
): MorphTimingTierSettings => ({
  settleDelayMs: clampTiming(value?.settleDelayMs, fallback.settleDelayMs),
  coverRampMs: clampTiming(value?.coverRampMs, fallback.coverRampMs),
  handoffFadeMs: clampTiming(value?.handoffFadeMs, fallback.handoffFadeMs),
  glimmCoverSweepMs: clampTiming(
    value?.glimmCoverSweepMs,
    fallback.glimmCoverSweepMs,
  ),
  glimmRevealSweepMs: clampTiming(
    value?.glimmRevealSweepMs,
    fallback.glimmRevealSweepMs,
  ),
  glimmOutroFadeMs: clampTiming(
    value?.glimmOutroFadeMs,
    fallback.glimmOutroFadeMs,
  ),
});

const normalizeTimingSettings = (
  timing: Partial<MorphTimingSettings> | null | undefined,
): MorphTimingSettings => ({
  hmr: normalizeTimingTier(timing?.hmr, DEFAULT_MORPH_TIMING_SETTINGS.hmr),
  reload: normalizeTimingTier(
    timing?.reload,
    DEFAULT_MORPH_TIMING_SETTINGS.reload,
  ),
});

const summarizeCaptureMeasurements = (
  samples: MorphCaptureMeasurement[],
): MorphCaptureBenchmarkResult["summary"] => {
  const successful = samples.filter((sample) => sample.ok);
  const captureTimes = successful.map((sample) => sample.capturePageMs);
  const totalTimes = successful.map((sample) => sample.totalDataUrlMs);
  const byteSizes = successful.map((sample) => sample.dataUrlBytes);
  const avg = (values: number[]) =>
    values.length
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : 0;
  return {
    count: successful.length,
    capturePageAvgMs: avg(captureTimes),
    capturePageMinMs: captureTimes.length ? Math.min(...captureTimes) : 0,
    capturePageMaxMs: captureTimes.length ? Math.max(...captureTimes) : 0,
    totalDataUrlAvgMs: avg(totalTimes),
    totalDataUrlMinMs: totalTimes.length ? Math.min(...totalTimes) : 0,
    totalDataUrlMaxMs: totalTimes.length ? Math.max(...totalTimes) : 0,
    avgDataUrlBytes: avg(byteSizes),
  };
};

export type MorphTestHandlersOptions = {
  getStellaRoot: () => string | null;
  getOverlayController: () => OverlayWindowController | null;
  getStellaHostRunner: () => StellaHostRunner | null;
  assertPrivilegedSender: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

const RENDERER_HMR_SCRATCH_REL = "desktop/src/app/morph-test/scratch.ts";
const FULL_RELOAD_METADATA_REL = "desktop/src/app/morph-test/metadata.ts";
const ELECTRON_RESTART_SCRATCH_REL =
  "desktop/electron/_morph_test_scratch.ts";

const HMR_SCRATCH_HEADER = `/**
 * Auto-edited by the morph-test app to trigger a renderer-HMR self-mod
 * run. These flags are rendered by the morph-test UI so each test has a
 * visible before/after state under the morph cover.
 */
`;

const ELECTRON_SCRATCH_HEADER = `/**
 * Auto-edited by the morph-test app to trigger a full Electron-binary
 * restart self-mod run. \`main.ts\` imports this file as a side effect so
 * esbuild keeps it in the bundled main process output. Every flag flip
 * changes \`dist-electron/desktop/electron/main.js\`, which
 * \`dev-electron.mjs\`'s chokidar watcher picks up via
 * \`shouldRestartElectronForBuildPath\` and uses to kill + relaunch the
 * Electron process.
 */
`;

type MorphTestFeatureState = {
  hmrFeature: boolean;
  reloadHmrDetail: boolean;
  restartHmrDetail: boolean;
  reloadFeature: boolean;
  restartReloadDetail: boolean;
  processRestartFeature: boolean;
};

const formatRendererScratch = (state: MorphTestFeatureState): string =>
  `${HMR_SCRATCH_HEADER}\nexport const MORPH_TEST_HMR_FEATURE_ENABLED = ${state.hmrFeature};\nexport const MORPH_TEST_RELOAD_HMR_DETAIL_ENABLED = ${state.reloadHmrDetail};\nexport const MORPH_TEST_RESTART_HMR_DETAIL_ENABLED = ${state.restartHmrDetail};\n`;

const formatMetadata = (state: MorphTestFeatureState): string => `import type { AppMetadata } from "../_shared/app-metadata";
import MorphTestIcon from "./MorphTestIcon";

export const MORPH_TEST_RELOAD_FEATURE_ENABLED = ${state.reloadFeature};
export const MORPH_TEST_RESTART_RELOAD_DETAIL_ENABLED = ${state.restartReloadDetail};

const metadata: AppMetadata = {
  id: "morph-test",
  label: "Morph test",
  icon: MorphTestIcon,
  route: "/morph-test",
  slot: "top",
  order: 900,
};

export default metadata;
`;

const formatElectronScratch = (state: MorphTestFeatureState): string =>
  `${ELECTRON_SCRATCH_HEADER}\nexport const MORPH_TEST_PROCESS_RESTART_FEATURE_ENABLED = ${state.processRestartFeature};\n\n(globalThis as typeof globalThis & {\n  __STELLA_MORPH_TEST_PROCESS_RESTART_FEATURE_ENABLED?: boolean;\n}).__STELLA_MORPH_TEST_PROCESS_RESTART_FEATURE_ENABLED =\n  MORPH_TEST_PROCESS_RESTART_FEATURE_ENABLED;\n`;

const readBooleanExport = async (
  absPath: string,
  exportName: string,
): Promise<boolean> => {
  try {
    const current = await fs.readFile(absPath, "utf-8");
    const match = new RegExp(
      `export const ${exportName}\\s*=\\s*(true|false)`,
    ).exec(current);
    if (match?.[1]) {
      return match[1] === "true";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return false;
};

const readFeatureState = async (
  stellaRoot: string,
): Promise<MorphTestFeatureState> => {
  const rendererPath = path.join(stellaRoot, RENDERER_HMR_SCRATCH_REL);
  const metadataPath = path.join(stellaRoot, FULL_RELOAD_METADATA_REL);
  const electronPath = path.join(stellaRoot, ELECTRON_RESTART_SCRATCH_REL);
  return {
    hmrFeature: await readBooleanExport(
      rendererPath,
      "MORPH_TEST_HMR_FEATURE_ENABLED",
    ),
    reloadHmrDetail: await readBooleanExport(
      rendererPath,
      "MORPH_TEST_RELOAD_HMR_DETAIL_ENABLED",
    ),
    restartHmrDetail: await readBooleanExport(
      rendererPath,
      "MORPH_TEST_RESTART_HMR_DETAIL_ENABLED",
    ),
    reloadFeature: await readBooleanExport(
      metadataPath,
      "MORPH_TEST_RELOAD_FEATURE_ENABLED",
    ),
    restartReloadDetail: await readBooleanExport(
      metadataPath,
      "MORPH_TEST_RESTART_RELOAD_DETAIL_ENABLED",
    ),
    processRestartFeature: await readBooleanExport(
      electronPath,
      "MORPH_TEST_PROCESS_RESTART_FEATURE_ENABLED",
    ),
  };
};

const resolveScenarioFiles = (
  scenario: MorphTestScenario,
  stellaRoot: string,
): string[] => {
  switch (scenario) {
    case "hmr":
      return [path.join(stellaRoot, RENDERER_HMR_SCRATCH_REL)];
    case "reload":
      return [
        path.join(stellaRoot, RENDERER_HMR_SCRATCH_REL),
        path.join(stellaRoot, FULL_RELOAD_METADATA_REL),
      ];
    case "restart":
      return [
        path.join(stellaRoot, RENDERER_HMR_SCRATCH_REL),
        path.join(stellaRoot, FULL_RELOAD_METADATA_REL),
        path.join(stellaRoot, ELECTRON_RESTART_SCRATCH_REL),
      ];
  }
};

const writeScenarioPayload = async (
  scenario: MorphTestScenario,
  stellaRoot: string,
): Promise<void> => {
  const current = await readFeatureState(stellaRoot);
  const next = { ...current };
  switch (scenario) {
    case "hmr": {
      next.hmrFeature = !current.hmrFeature;
      break;
    }
    case "reload": {
      const enabled = !current.reloadFeature;
      next.reloadFeature = enabled;
      next.reloadHmrDetail = enabled;
      break;
    }
    case "restart": {
      const enabled = !current.processRestartFeature;
      next.processRestartFeature = enabled;
      next.restartReloadDetail = enabled;
      next.restartHmrDetail = enabled;
      break;
    }
  }

  await Promise.all([
    fs.writeFile(
      path.join(stellaRoot, RENDERER_HMR_SCRATCH_REL),
      formatRendererScratch(next),
      "utf-8",
    ),
    ...(scenario === "reload" || scenario === "restart"
      ? [
          fs.writeFile(
            path.join(stellaRoot, FULL_RELOAD_METADATA_REL),
            formatMetadata(next),
            "utf-8",
          ),
        ]
      : []),
    ...(scenario === "restart"
      ? [
          fs.writeFile(
            path.join(stellaRoot, ELECTRON_RESTART_SCRATCH_REL),
            formatElectronScratch(next),
            "utf-8",
          ),
        ]
      : []),
  ]);
};

export const registerMorphTestHandlers = (
  options: MorphTestHandlersOptions,
) => {
  ipcMain.handle(
    IPC_MORPH_TEST_SET_PREFERRED_FLAVOR,
    async (
      event,
      payload?: { flavor?: MorphTestPreferredFlavor | null },
    ): Promise<{ ok: boolean; flavor: MorphTestPreferredFlavor | null }> => {
      if (
        !options.assertPrivilegedSender(event, IPC_MORPH_TEST_SET_PREFERRED_FLAVOR)
      ) {
        throw new Error(
          "Blocked untrusted morphTest:setPreferredFlavor request.",
        );
      }
      const overlay = options.getOverlayController();
      const requested = payload?.flavor;
      const normalized: MorphTestPreferredFlavor | null =
        requested === "glimm" || requested === "ripple" ? requested : null;
      // Only the "glimm" choice needs an override; "ripple" is the
      // controller's intrinsic default for hmr-flavored transitions.
      const override =
        normalized === "glimm" ? "glimm" : null;
      overlay?.setHmrFlavorOverride(override);
      return { ok: true, flavor: normalized };
    },
  );

  ipcMain.handle(
    IPC_MORPH_TEST_GET_TIMING_SETTINGS,
    async (
      event,
    ): Promise<{ ok: boolean; timing: MorphTimingSettings }> => {
      if (
        !options.assertPrivilegedSender(
          event,
          IPC_MORPH_TEST_GET_TIMING_SETTINGS,
        )
      ) {
        throw new Error(
          "Blocked untrusted morphTest:getTimingSettings request.",
        );
      }
      return {
        ok: true,
        timing:
          options.getOverlayController()?.getHmrTimingOverride() ??
          DEFAULT_MORPH_TIMING_SETTINGS,
      };
    },
  );

  ipcMain.handle(
    IPC_MORPH_TEST_SET_TIMING_SETTINGS,
    async (
      event,
      payload?: { timing?: Partial<MorphTimingSettings> | null },
    ): Promise<{ ok: boolean; timing: MorphTimingSettings }> => {
      if (
        !options.assertPrivilegedSender(
          event,
          IPC_MORPH_TEST_SET_TIMING_SETTINGS,
        )
      ) {
        throw new Error(
          "Blocked untrusted morphTest:setTimingSettings request.",
        );
      }
      const timing = normalizeTimingSettings(payload?.timing);
      options.getOverlayController()?.setHmrTimingOverride(timing);
      return { ok: true, timing };
    },
  );

  ipcMain.handle(
    IPC_MORPH_TEST_RESET_TIMING_SETTINGS,
    async (
      event,
    ): Promise<{ ok: boolean; timing: MorphTimingSettings }> => {
      if (
        !options.assertPrivilegedSender(
          event,
          IPC_MORPH_TEST_RESET_TIMING_SETTINGS,
        )
      ) {
        throw new Error(
          "Blocked untrusted morphTest:resetTimingSettings request.",
        );
      }
      options.getOverlayController()?.setHmrTimingOverride(null);
      return { ok: true, timing: DEFAULT_MORPH_TIMING_SETTINGS };
    },
  );

  ipcMain.handle(
    IPC_MORPH_TEST_MEASURE_CAPTURE,
    async (
      event,
      payload?: { samples?: number },
    ): Promise<MorphCaptureBenchmarkResult> => {
      if (
        !options.assertPrivilegedSender(
          event,
          IPC_MORPH_TEST_MEASURE_CAPTURE,
        )
      ) {
        throw new Error(
          "Blocked untrusted morphTest:measureCapture request.",
        );
      }

      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) {
        throw new Error("Morph test window is unavailable.");
      }

      const sampleCount = Math.min(
        20,
        Math.max(1, Math.round(payload?.samples ?? 8)),
      );
      const samples: MorphCaptureMeasurement[] = [];
      for (let index = 0; index < sampleCount; index += 1) {
        let capturePageMs = 0;
        const startedAt = performance.now();
        const dataUrl = await captureWindowDataUrl(
          win,
          undefined,
          (_ok, durationMs) => {
            capturePageMs = durationMs;
          },
        );
        samples.push({
          index,
          ok: dataUrl != null,
          capturePageMs,
          totalDataUrlMs: Math.round(performance.now() - startedAt),
          dataUrlBytes: dataUrl?.length ?? 0,
        });
      }

      const result: MorphCaptureBenchmarkResult = {
        ok: samples.every((sample) => sample.ok),
        samples,
        summary: summarizeCaptureMeasurements(samples),
      };
      console.log("[morph-test] capture benchmark", result.summary);
      return result;
    },
  );

  ipcMain.handle(
    IPC_MORPH_TEST_TRIGGER_SELF_MOD,
    async (
      event,
      payload?: { scenario?: MorphTestScenario },
    ): Promise<{
      ok: boolean;
      scenario: MorphTestScenario;
      filePath: string;
      runId: string;
    }> => {
      if (
        !options.assertPrivilegedSender(event, IPC_MORPH_TEST_TRIGGER_SELF_MOD)
      ) {
        throw new Error(
          "Blocked untrusted morphTest:triggerSelfMod request.",
        );
      }
      const scenario = payload?.scenario;
      if (
        scenario !== "hmr" &&
        scenario !== "reload" &&
        scenario !== "restart"
      ) {
        throw new Error(
          `Unknown morphTest:triggerSelfMod scenario: ${String(scenario)}`,
        );
      }
      const stellaRoot = options.getStellaRoot();
      if (!stellaRoot) {
        throw new Error("Stella install directory is unavailable.");
      }

      const absPaths = resolveScenarioFiles(scenario, stellaRoot);
      const relPaths = absPaths.map((absPath) =>
        path.relative(stellaRoot, absPath).replace(/\\/g, "/"),
      );
      const relPath = relPaths.join(", ");
      const runId = `morph-test:${scenario}:${Date.now()}:${randomUUID()}`;

      const runner = options.getStellaHostRunner();
      if (!runner) {
        throw new Error(
          "Stella runtime is not available — start the worker before triggering a morph test.",
        );
      }

      console.log(
        `[morph-test] scenario=${scenario} runId=${runId} relPath=${relPath}`,
      );
      const beganAt = Date.now();
      await runner.beginExternalSelfMod({ runId, paths: relPaths });
      console.log(
        `[morph-test] begin returned after ${Date.now() - beganAt}ms`,
      );
      try {
        const writeAt = Date.now();
        await writeScenarioPayload(scenario, stellaRoot);
        console.log(
          `[morph-test] file write returned after ${Date.now() - writeAt}ms`,
        );
      } catch (error) {
        console.warn(
          `[morph-test] file write failed:`,
          (error as Error).message,
        );
        await runner
          .finishExternalSelfMod({ runId, succeeded: false })
          .catch(() => undefined);
        throw error;
      }
      const finishAt = Date.now();
      await runner.finishExternalSelfMod({ runId, succeeded: true });
      console.log(
        `[morph-test] finish returned after ${Date.now() - finishAt}ms (total ${Date.now() - beganAt}ms)`,
      );
      return { ok: true, scenario, filePath: relPath, runId };
    },
  );
};
