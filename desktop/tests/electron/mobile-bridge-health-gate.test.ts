import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBridgeService } from "../../electron/services/mobile-bridge/service.js";

const TUNNEL_URL = "https://desktop.example.com";

const createService = () =>
  new MobileBridgeService({
    electronDir: "/tmp/stella-test/desktop/electron",
    isDev: false,
    getDevServerUrl: () => "http://127.0.0.1:5173",
  });

const configureReadyService = (service: MobileBridgeService) => {
  const anyService = service as any;
  anyService.port = 4318;
  anyService.convexSiteUrl = "https://example.convex.site";
  anyService.hostAuthToken = "desktop-token";
  anyService.deviceId = "desktop-device";
  anyService.tunnelUrl = TUNNEL_URL;
  return anyService;
};

/** Routes the desktop's Convex calls to in-memory counters. */
const mockBridgeCalls = (anyService: any) => {
  const counts = { register: 0, clear: 0 };
  anyService.postBridgeJson = vi.fn(
    async (_siteUrl: string, route: string) => {
      if (route.endsWith("/register")) {
        counts.register += 1;
        return new Response(
          JSON.stringify({ ok: true, leaseExpiresAt: Date.now() + 150_000 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (route.endsWith("/clear")) {
        counts.clear += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
  );
  return counts;
};

/** Toggleable `/bridge/health` probe used by probePublicTunnelHealth. */
const mockHealth = () => {
  const state = { healthy: true };
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    state.healthy
      ? new Response(JSON.stringify({ ok: true }), { status: 200 })
      : new Response("unavailable", { status: 503 }),
  );
  return state;
};

describe("MobileBridgeService health-gated registration", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers only after the advertised public URL passes a health probe", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const counts = mockBridgeCalls(anyService);
    mockHealth(); // healthy by default

    await anyService.syncRegistration();

    expect(counts.register).toBe(1);
    expect(counts.clear).toBe(0);
    expect(anyService.registrationState).toBe("healthy");
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    anyService.clearRegistrationLeaseTimer();
  });

  it("keeps the lease on a single transient probe miss (no down-register)", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const counts = mockBridgeCalls(anyService);
    const health = mockHealth();

    await anyService.syncRegistration(); // establish lease
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    health.healthy = false;
    await anyService.syncRegistration(); // 1 failure, below threshold

    expect(counts.clear).toBe(0);
    expect(anyService.registrationState).toBe("degraded");
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    anyService.clearRegistrationLeaseTimer();
  });

  it("clears availability after sustained failures, then re-registers on recovery", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const counts = mockBridgeCalls(anyService);
    const health = mockHealth();

    await anyService.syncRegistration(); // establish lease
    expect(anyService.isBridgeAccessEnabled()).toBe(true);
    const registersBeforeOutage = counts.register;

    // Sustained outage: threshold is 3 consecutive failed probes.
    health.healthy = false;
    await anyService.syncRegistration(); // streak 1
    await anyService.syncRegistration(); // streak 2
    expect(counts.clear).toBe(0);
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    await anyService.syncRegistration(); // streak 3 -> clear
    expect(counts.clear).toBe(1);
    expect(anyService.isBridgeAccessEnabled()).toBe(false);
    // No new registrations were sent against the dead URL during the outage.
    expect(counts.register).toBe(registersBeforeOutage);

    // Recovery: health returns -> streak resets -> re-register.
    health.healthy = true;
    await anyService.syncRegistration();
    expect(counts.register).toBe(registersBeforeOutage + 1);
    expect(anyService.isBridgeAccessEnabled()).toBe(true);

    anyService.clearRegistrationLeaseTimer();
  });

  it("coalesces overlapping sync calls so probes/registrations never stack", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const counts = mockBridgeCalls(anyService);
    mockHealth();

    await anyService.syncRegistration(); // establish lease
    const registersBefore = counts.register;

    // Fire several at once; the guard should collapse them into the in-flight
    // pass plus at most one queued pass.
    await Promise.all([
      anyService.syncRegistration(),
      anyService.syncRegistration(),
      anyService.syncRegistration(),
      anyService.syncRegistration(),
      anyService.syncRegistration(),
    ]);

    expect(counts.register - registersBefore).toBeLessThanOrEqual(2);
    expect(counts.register - registersBefore).toBeGreaterThanOrEqual(1);

    anyService.clearRegistrationLeaseTimer();
  });
});
