import { beforeEach, describe, expect, it, vi } from "vitest";
import { METHOD_NAMES } from "../../../packages/runtime-protocol/index.js";

const {
  createStellaHostRunnerMock,
  createSelfModHmrControllerMock,
  capabilityRuntimeLoadMock,
} = vi.hoisted(() => ({
  createStellaHostRunnerMock: vi.fn(),
  createSelfModHmrControllerMock: vi.fn(() => ({
    pause: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    forceResumeAll: vi.fn(async () => true),
    getStatus: vi.fn(async () => null),
  })),
  capabilityRuntimeLoadMock: vi.fn(async () => {}),
}));

vi.mock("../../../packages/runtime-kernel/runner.js", () => ({
  createStellaHostRunner: createStellaHostRunnerMock,
}));

vi.mock("../../../packages/runtime-kernel/self-mod/hmr.js", () => ({
  createSelfModHmrController: createSelfModHmrControllerMock,
}));

vi.mock("../../../packages/runtime-kernel/storage/database.js", () => ({
  createDesktopDatabase: () => ({
    exec: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock("../../../packages/runtime-kernel/storage/chat-store.js", () => ({
  ChatStore: class ChatStore {
    listEvents() {
      return [];
    }
  },
}));

vi.mock("../../../packages/runtime-kernel/storage/runtime-store.js", () => ({
  RuntimeStore: class RuntimeStore {
    appendThreadMessage() {}
  },
}));

vi.mock("../../../packages/runtime-kernel/storage/store-mod-store.js", () => ({
  StoreModStore: class StoreModStore {},
}));

vi.mock("../../../packages/runtime-kernel/storage/transcript-mirror.js", () => ({
  TranscriptMirror: class TranscriptMirror {},
}));

vi.mock("../../../packages/runtime-kernel/self-mod/store-mod-service.js", () => ({
  StoreModService: class StoreModService {
    beginSelfModRun = vi.fn(async () => {});
    finalizeSelfModRun = vi.fn(async () => {});
    cancelSelfModRun = vi.fn(() => {});
  },
}));

vi.mock("../../../packages/runtime-worker/social-sessions/store.js", () => ({
  SocialSessionStore: class SocialSessionStore {},
}));

vi.mock("../../../packages/runtime-worker/social-sessions/service.js", () => ({
  SocialSessionService: class SocialSessionService {
    setConvexUrl() {}
    setAuthToken() {}
    start() {}
    stop() {}
  },
}));

vi.mock("../../../packages/runtime-worker/voice/service.js", () => ({
  VoiceRuntimeService: class VoiceRuntimeService {},
}));

vi.mock("../../../packages/runtime-kernel/dev-projects/dev-project-service.js", () => ({
  DevProjectService: class DevProjectService {
    subscribe() {
      return () => {};
    }
    async listProjects() {
      return [];
    }
    async stopAll() {}
  },
}));

vi.mock("../../../packages/runtime-kernel/local-scheduler-service.js", () => ({
  LocalSchedulerService: class LocalSchedulerService {
    subscribe() {
      return () => {};
    }
    start() {}
    stop() {}
    async listCronJobs() {
      return [];
    }
    async addCronJob() {}
    async updateCronJob() {}
    async removeCronJob() {}
    async runCronJob() {}
    async getHeartbeatConfig() {
      return null;
    }
    async upsertHeartbeat() {}
    async runHeartbeat() {}
  },
}));

vi.mock("../../../packages/runtime-capabilities/runtime.js", () => ({
  CapabilityRuntime: class CapabilityRuntime {
    async load() {
      await capabilityRuntimeLoadMock();
    }
    getLoadedSourcePaths() {
      return [];
    }
  },
}));

vi.mock("../../../electron/dev-url.js", () => ({
  getDevServerUrl: () => "http://localhost:5714",
}));

const { createRuntimeWorkerServer } = await import(
  "../../../packages/runtime-worker/server.js"
);

type MockPeer = {
  request: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  registerRequestHandler: (
    method: string,
    handler: (params: unknown) => Promise<unknown>,
  ) => void;
};

describe("runtime worker server", () => {
  beforeEach(() => {
    createStellaHostRunnerMock.mockReset();
    capabilityRuntimeLoadMock.mockClear();
  });

  it("provides a host-backed transition controller and requires a runId for HMR resume", async () => {
    const requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
    const peer: MockPeer = {
      request: vi.fn(async (method: string) => {
        switch (method) {
          case METHOD_NAMES.HOST_DEVICE_IDENTITY_GET:
            return { deviceId: "device-1", publicKey: "public-key" };
          case METHOD_NAMES.HOST_HMR_RUN_TRANSITION:
            return { ok: true };
          default:
            return { ok: true };
        }
      }),
      notify: vi.fn(),
      registerRequestHandler: (method, handler) => {
        requestHandlers.set(method, handler);
      },
    };

    const runner = {
      setConvexUrl: vi.fn(),
      setAuthToken: vi.fn(),
      setCloudSyncEnabled: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      resumeSelfModHmr: vi.fn(async () => true),
      hookEmitter: {},
    };
    createStellaHostRunnerMock.mockReturnValue(runner);

    createRuntimeWorkerServer(peer as never);

    const initialize = requestHandlers.get(METHOD_NAMES.INTERNAL_WORKER_INITIALIZE);
    expect(initialize).toBeTypeOf("function");

    await initialize?.({
      stellaHomePath: "/mock/home/.stella",
      stellaWorkspacePath: "/mock/workspace",
      frontendRoot: "/mock/frontend",
      authToken: null,
      convexUrl: null,
      convexSiteUrl: null,
      cloudSyncEnabled: false,
    });

    const runnerOptions = createStellaHostRunnerMock.mock.calls[0]?.[0];
    expect(runnerOptions?.getHmrTransitionController).toBeTypeOf("function");

    const hmrTransitionController = runnerOptions.getHmrTransitionController();
    await hmrTransitionController.runTransition({
      runId: "run-self-mod-1",
      requiresFullReload: false,
      resumeHmr: async () => {},
    });

    expect(peer.request).toHaveBeenCalledWith(
      METHOD_NAMES.HOST_HMR_RUN_TRANSITION,
      { runId: "run-self-mod-1", requiresFullReload: false },
    );

    const resumeHandler = requestHandlers.get(METHOD_NAMES.INTERNAL_WORKER_RESUME_HMR);
    expect(resumeHandler).toBeTypeOf("function");

    await expect(resumeHandler?.({})).rejects.toThrow(
      "INTERNAL_WORKER_RESUME_HMR requires a runId.",
    );
    await resumeHandler?.({ runId: "run-self-mod-1" });

    expect(runner.resumeSelfModHmr).toHaveBeenCalledWith("run-self-mod-1");
  });
});
