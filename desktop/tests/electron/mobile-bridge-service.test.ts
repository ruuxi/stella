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
    // syncRegistration now probes the advertised tunnel's /bridge/health before
    // registering; default it to reachable so these tests exercise the
    // registration-response handling. The health-gate behavior itself is
    // covered in mobile-bridge-health-gate.test.ts.
    vi.spyOn(
      MobileBridgeService.prototype as unknown as {
        probePublicTunnelHealth: (url: string) => Promise<boolean>;
      },
      "probePublicTunnelHealth",
    ).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("stores the server-provided lease expiry after successful registration", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const leaseExpiresAt = Date.now() + 120_000;
    anyService.postBridgeJson = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, leaseExpiresAt }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
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
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

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
    anyService.postBridgeJson = vi
      .fn()
      .mockResolvedValue(new Response("Server error", { status: 500 }));
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

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
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

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
    anyService.postBridgeJson = vi
      .fn()
      .mockResolvedValue(new Response("Forbidden", { status: 403 }));

    await anyService.syncRegistration();

    expect(anyService.registrationState).toBe("revoked");
    expect(anyService.registrationLeaseExpiresAt).toBeNull();
    expect(anyService.isBridgeAccessEnabled()).toBe(false);
  });

  it("prefers explicit session headers over a stale cookie", async () => {
    // Regression: a request carrying a previous send's session cookie plus the
    // current send's session headers must authorize the *header* session. The
    // cookie used to win, so the desktop decrypted the new payload with the old
    // session's keys and the phone saw a spurious "session expired".
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
    anyService.registrationState = "healthy";

    const staleSession = {
      expiresAt: Date.now() + 60_000,
      sessionSecret: "secret-old",
      mobileDeviceId: "old",
      crypto: { marker: "old" },
    };
    const freshSession = {
      expiresAt: Date.now() + 60_000,
      sessionSecret: "secret-new",
      mobileDeviceId: "new",
      crypto: { marker: "new" },
    };
    anyService.sessions.set("cookie-old", staleSession);
    anyService.sessions.set("session-new", freshSession);

    const req = {
      headers: {
        cookie: "stella_mobile_bridge=cookie-old",
        "x-stella-bridge-session-id": "session-new",
        "x-stella-bridge-session-secret": "secret-new",
        "x-stella-bridge-challenge-id": "challenge-new",
      },
    };
    const res = { setHeader: vi.fn() };

    const resolved = await anyService.ensureAuthorized(req, res, null);

    expect(resolved).toBe(freshSession);
    expect(resolved).not.toBe(staleSession);
  });

  it("falls back to the cookie when no session headers are present", async () => {
    // WebView sub-resources (scripts, images) can't set custom headers, so the
    // cookie path must still authorize them.
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
    anyService.registrationState = "healthy";

    const cookieSession = {
      expiresAt: Date.now() + 60_000,
      sessionSecret: "secret",
      mobileDeviceId: "web",
      crypto: { marker: "web" },
    };
    anyService.sessions.set("cookie-web", cookieSession);

    const req = { headers: { cookie: "stella_mobile_bridge=cookie-web" } };
    const res = { setHeader: vi.fn() };

    const resolved = await anyService.ensureAuthorized(req, res, null);

    expect(resolved).toBe(cookieSession);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("filters source-diff display updates unless developer previews are enabled", () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
    anyService.registrationState = "healthy";
    const ws = {
      close: vi.fn(),
      send: vi.fn(),
      readyState: WebSocket.OPEN,
    } as unknown as WebSocket;
    anyService.wsClients.set(ws, {
      authenticated: true,
      subscriptions: new Set(["display:update"]),
    });

    service.broadcastToMobile("display:update", {
      kind: "source-diff",
      filePath: "/repo/src/app.tsx",
    });
    expect(ws.send).not.toHaveBeenCalled();

    anyService.lastBootstrapPayload = {
      localStorage: { "stella-developer-resource-previews": "true" },
      mobileBridgeCapabilities: { version: 1, capabilities: [] },
    };
    service.broadcastToMobile("display:update", {
      kind: "source-diff",
      filePath: "/repo/src/app.tsx",
    });
    expect(ws.send).toHaveBeenCalledTimes(1);
  });
});
