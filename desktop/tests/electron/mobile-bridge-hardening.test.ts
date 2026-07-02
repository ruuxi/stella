import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBridgeService } from "../../electron/services/mobile-bridge/service.js";
import {
  isMobileBridgeRequestChannel,
  isMobileBridgeEventChannel,
} from "../../electron/services/mobile-bridge/bridge-policy.js";
import { MOBILE_BRIDGE_FEATURES } from "../../electron/services/mobile-bridge/capabilities.js";

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
  anyService.hostAuthToken = "token";
  anyService.deviceId = "desktop-device";
  anyService.tunnelUrl = "https://desktop.example.com";
  anyService.registrationState = "healthy";
  anyService.registrationLeaseExpiresAt = Date.now() + 120_000;
  return anyService;
};

type FakeResponse = {
  statusCode: number | null;
  body: string;
  headersSent: boolean;
  writeHead: (status: number, headers?: Record<string, unknown>) => void;
  setHeader: (name: string, value: string) => void;
  end: (chunk?: unknown) => void;
};

const createFakeResponse = (): FakeResponse => {
  const res: FakeResponse = {
    statusCode: null,
    body: "",
    headersSent: false,
    writeHead: (status) => {
      res.statusCode = status;
      res.headersSent = true;
    },
    setHeader: () => {},
    end: (chunk) => {
      if (chunk != null) res.body = String(chunk);
    },
  };
  return res;
};

const challengeRequest = (url: string) => ({
  url,
  method: "GET",
  headers: {},
});

describe("challenge endpoint hardening", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("serves a challenge when the caller presents the right device id", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const res = createFakeResponse();
    await anyService.handleRequest(
      challengeRequest("/bridge/challenge?d=desktop-device"),
      res,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.desktopDeviceId).toBe("desktop-device");
    expect(typeof body.challenge).toBe("string");
  });

  it("returns an opaque 404 for a mismatched device id (no id/key leak)", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const res = createFakeResponse();
    await anyService.handleRequest(
      challengeRequest("/bridge/challenge?d=some-other-device"),
      res,
    );
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ error: "Not found" });
    expect(res.body.includes("desktop-device")).toBe(false);
  });

  it("keeps serving bare challenges (legacy phones) but rate limits them", async () => {
    const service = createService();
    const anyService = configureReadyService(service);
    let limited = 0;
    let served = 0;
    for (let i = 0; i < 40; i += 1) {
      const res = createFakeResponse();
      await anyService.handleRequest(challengeRequest("/bridge/challenge"), res);
      if (res.statusCode === 200) served += 1;
      if (res.statusCode === 429) limited += 1;
    }
    expect(served).toBe(30);
    expect(limited).toBe(10);
  });
});

describe("staged upload attachment resolution", () => {
  it("swaps uploadId references for staged data URLs and keeps inline ones", () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.uploads.set("upload-1", {
      dataUrl: "data:image/jpeg;base64,aGVsbG8=",
      mimeType: "image/jpeg",
      expiresAt: Date.now() + 60_000,
      bytes: 5,
    });
    const args = anyService.resolveUploadedAttachments("agent:startChat", [
      {
        conversationId: "c1",
        attachments: [
          { uploadId: "upload-1", mimeType: "image/jpeg" },
          { url: "data:image/png;base64,aW5saW5l", mimeType: "image/png" },
        ],
      },
    ]);
    expect(args[0].attachments).toEqual([
      { url: "data:image/jpeg;base64,aGVsbG8=", mimeType: "image/jpeg" },
      { url: "data:image/png;base64,aW5saW5l", mimeType: "image/png" },
    ]);
    // Not consumed on use — a deduped startChat retry must still resolve.
    expect(anyService.uploads.has("upload-1")).toBe(true);
  });

  it("throws a user-actionable error for expired uploads", () => {
    const service = createService();
    const anyService = configureReadyService(service);
    anyService.uploads.set("upload-old", {
      dataUrl: "data:image/jpeg;base64,aGVsbG8=",
      mimeType: "image/jpeg",
      expiresAt: Date.now() - 1,
      bytes: 5,
    });
    expect(() =>
      anyService.resolveUploadedAttachments("agent:startChat", [
        { attachments: [{ uploadId: "upload-old" }] },
      ]),
    ).toThrow(/upload expired/i);
  });

  it("leaves non-startChat channels and legacy args untouched", () => {
    const service = createService();
    const anyService = configureReadyService(service);
    const args = [{ attachments: [{ uploadId: "whatever" }] }];
    expect(
      anyService.resolveUploadedAttachments("localChat:syncMessages", args),
    ).toBe(args);
    const noAttachments = [{ conversationId: "c1" }];
    expect(
      anyService.resolveUploadedAttachments("agent:startChat", noAttachments),
    ).toBe(noAttachments);
  });
});

describe("bridge capability surface", () => {
  it("whitelists mobile:hello as a request channel", () => {
    expect(isMobileBridgeRequestChannel("mobile:hello")).toBe(true);
  });

  it("still whitelists the localChat push event channel", () => {
    expect(isMobileBridgeEventChannel("localChat:updated")).toBe(true);
  });

  it("advertises the negotiated feature set", () => {
    expect(MOBILE_BRIDGE_FEATURES).toContain("hello-v1");
    expect(MOBILE_BRIDGE_FEATURES).toContain("envelope-deflate");
    expect(MOBILE_BRIDGE_FEATURES).toContain("binary-file-lane");
    expect(MOBILE_BRIDGE_FEATURES).toContain("binary-upload");
    expect(MOBILE_BRIDGE_FEATURES).toContain("localchat-push");
  });
});
