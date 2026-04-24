import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { MobileBridgeService } from "../../electron/services/mobile-bridge/service.js";

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
  anyService.tunnelUrl = "https://desktop.example.com";
  return anyService;
};

describe("MobileBridgeService registration lease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T00:00:00Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("stores the server-provided lease expiry after successful registration", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const leaseExpiresAt = Date.now() + 120_000;
    anyService.postBridgeJson = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, leaseExpiresAt }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await anyService.syncRegistration();

    expect(anyService.registrationState).toBe("healthy");
    expect(anyService.registrationLeaseExpiresAt).toBe(leaseExpiresAt);
    expect(anyService.isBridgeAccessEnabled()).toBe(true);
  });

  it("keeps the existing lease during transient registration failures", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
    anyService.registrationState = "healthy";
    anyService.postBridgeJson = vi
      .fn()
      .mockRejectedValue(new Error("temporary network issue"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await anyService.syncRegistration();
    } finally {
      warnSpy.mockRestore();
    }

    expect(anyService.registrationState).toBe("degraded");
    expect(anyService.isBridgeAccessEnabled()).toBe(true);
  });

  it("keeps the existing lease during non-auth registration rejections", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
    anyService.registrationState = "healthy";
    anyService.postBridgeJson = vi.fn().mockResolvedValue(
      new Response("Server error", { status: 500 }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await anyService.syncRegistration();
    } finally {
      warnSpy.mockRestore();
    }

    expect(anyService.registrationState).toBe("degraded");
    expect(anyService.isBridgeAccessEnabled()).toBe(true);
  });

  it("expires bridge access when a successful response omits lease details", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.postBridgeJson = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await anyService.syncRegistration();
    } finally {
      warnSpy.mockRestore();
    }

    expect(anyService.registrationState).toBe("expired");
    expect(anyService.registrationLeaseExpiresAt).toBeNull();
    expect(anyService.isBridgeAccessEnabled()).toBe(false);
  });

  it("expires active sessions and sockets when the lease runs out", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      readyState: WebSocket.OPEN,
    } as unknown as WebSocket;

    anyService.wsClients.set(ws, {
      authenticated: true,
      subscriptions: new Set(["display:update"]),
    });
    anyService.sessions.set("session-1", {
      expiresAt: Date.now() + 60_000,
    });
    anyService.setRegistrationLease(Date.now() + 1_000);
    anyService.registrationState = "healthy";

    await vi.advanceTimersByTimeAsync(1_001);

    expect(anyService.registrationState).toBe("expired");
    expect(anyService.registrationLeaseExpiresAt).toBeNull();
    expect(anyService.isBridgeAccessEnabled()).toBe(false);
    expect(ws.close).toHaveBeenCalledWith(4001, "Desktop bridge lease expired");
    expect(anyService.wsClients.size).toBe(0);
    expect(anyService.sessions.size).toBe(0);
  });

  it("revokes bridge access when registration is rejected for auth", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
    anyService.registrationState = "healthy";
    anyService.postBridgeJson = vi.fn().mockResolvedValue(
      new Response("Forbidden", { status: 403 }),
    );

    await anyService.syncRegistration();

    expect(anyService.registrationState).toBe("revoked");
    expect(anyService.registrationLeaseExpiresAt).toBeNull();
    expect(anyService.isBridgeAccessEnabled()).toBe(false);
  });
});
