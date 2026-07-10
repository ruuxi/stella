import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  policyFile: undefined as string | undefined,
  showMessageBox: vi.fn(),
  ensurePrivateDir: vi.fn(),
  writePrivateFile: vi.fn(async (_path: string, content: string) => {
    mocks.policyFile = content;
  }),
  readFile: vi.fn(async () => {
    if (mocks.policyFile === undefined) {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    }
    return mocks.policyFile;
  }),
}));

vi.mock("fs", () => ({
  promises: {
    readFile: mocks.readFile,
  },
}));

vi.mock("../../../runtime/kernel/home/private-fs.js", () => ({
  ensurePrivateDir: mocks.ensurePrivateDir,
  writePrivateFile: mocks.writePrivateFile,
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getFocusedWindow: vi.fn(() => null),
  },
  dialog: {
    showMessageBox: mocks.showMessageBox,
  },
}));

const { SecurityPolicyService } = await import(
  "../../electron/services/security-policy-service.js"
);

const createService = () => {
  const service = new SecurityPolicyService({
    windowManagerTarget: {
      getWindowManager: () => null,
    } as never,
  });
  service.setSecurityPolicyPath("/state/security_policy.json");
  return service;
};

const request = {
  bundleIdentifier: "Com.Example.Notes",
  displayName: "Notes",
  risk: "Can edit documents",
  warningSubtitle: "Computer Use can interact with this app.",
  allowPersistentApproval: true,
};

beforeEach(() => {
  mocks.policyFile = undefined;
  mocks.showMessageBox.mockReset();
  mocks.ensurePrivateDir.mockClear();
  mocks.writePrivateFile.mockClear();
  mocks.readFile.mockClear();
});

describe("SecurityPolicyService Computer Use app approvals", () => {
  it("keeps an unchecked approval for the current service session only", async () => {
    mocks.showMessageBox.mockResolvedValue({
      response: 0,
      checkboxChecked: false,
    });
    const service = createService();

    await expect(
      service.ensureComputerUseAppApproval(request),
    ).resolves.toEqual({
      decision: "approved",
      scope: "session",
    });
    await expect(
      service.ensureComputerUseAppApproval({
        ...request,
        bundleIdentifier: "com.example.notes",
      }),
    ).resolves.toEqual({ decision: "approved", scope: "session" });

    expect(mocks.showMessageBox).toHaveBeenCalledOnce();
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Stella Security Confirmation",
        message: "Allow Computer Use to use Notes?",
        detail:
          "Computer Use can interact with this app.\n\nRisk: Can edit documents",
        buttons: ["Allow", "Deny"],
        checkboxLabel: "Remember this decision on this device",
      }),
    );
    expect(mocks.writePrivateFile).not.toHaveBeenCalled();

    const restartedService = createService();
    await restartedService.ensureComputerUseAppApproval(request);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("persists a remembered approval and restores it on load", async () => {
    mocks.showMessageBox.mockResolvedValue({
      response: 0,
      checkboxChecked: true,
    });
    const service = createService();

    await expect(
      service.ensureComputerUseAppApproval(request),
    ).resolves.toEqual({
      decision: "approved",
      scope: "persistent",
    });
    expect(JSON.parse(mocks.policyFile!)).toEqual({
      version: 2,
      approved: [],
      computerUseAppApprovals: {
        "com.example.notes": true,
      },
    });

    const reloadedService = createService();
    await reloadedService.loadPolicy();
    mocks.showMessageBox.mockClear();
    await expect(
      reloadedService.ensureComputerUseAppApproval(request),
    ).resolves.toEqual({
      decision: "approved",
      scope: "persistent",
    });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("does not cache or persist declines", async () => {
    mocks.showMessageBox.mockResolvedValue({
      response: 1,
      checkboxChecked: true,
    });
    const service = createService();

    await expect(
      service.ensureComputerUseAppApproval(request),
    ).resolves.toEqual({
      decision: "declined",
      scope: "none",
    });
    await service.ensureComputerUseAppApproval(request);

    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
    expect(mocks.writePrivateFile).not.toHaveBeenCalled();
  });

  it("omits and ignores persistent approval when it is disallowed", async () => {
    mocks.showMessageBox.mockResolvedValue({
      response: 0,
      checkboxChecked: true,
    });
    const service = createService();

    await expect(
      service.ensureComputerUseAppApproval({
        ...request,
        allowPersistentApproval: false,
      }),
    ).resolves.toEqual({ decision: "approved", scope: "session" });

    const dialogOptions = mocks.showMessageBox.mock.calls[0]?.[0];
    expect(dialogOptions).not.toHaveProperty("checkboxLabel");
    expect(dialogOptions).not.toHaveProperty("checkboxChecked");
    expect(mocks.writePrivateFile).not.toHaveBeenCalled();
  });

  it("loads legacy privileged-action approvals and retains them when migrating", async () => {
    mocks.policyFile = JSON.stringify({
      version: 1,
      approved: ["v1:reset-local-data", "invalid-entry"],
    });
    const service = createService();
    await service.loadPolicy();

    await expect(
      service.ensureApproval(
        "reset-local-data",
        "Reset?",
        "This deletes local data.",
      ),
    ).resolves.toBe(true);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();

    mocks.showMessageBox.mockResolvedValue({
      response: 0,
      checkboxChecked: true,
    });
    await service.ensureComputerUseAppApproval(request);
    expect(JSON.parse(mocks.policyFile!)).toEqual({
      version: 2,
      approved: ["v1:reset-local-data"],
      computerUseAppApprovals: {
        "com.example.notes": true,
      },
    });
  });

  it("clearAll removes session and loaded persistent approvals from memory", async () => {
    mocks.showMessageBox.mockResolvedValue({
      response: 0,
      checkboxChecked: false,
    });
    const service = createService();
    await service.ensureComputerUseAppApproval(request);
    service.clearAll();
    await service.ensureComputerUseAppApproval(request);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);

    mocks.policyFile = JSON.stringify({
      version: 2,
      approved: [],
      computerUseAppApprovals: { "com.example.calendar": true },
    });
    const loadedService = createService();
    await loadedService.loadPolicy();
    loadedService.clearAll();
    await loadedService.ensureComputerUseAppApproval({
      ...request,
      bundleIdentifier: "com.example.calendar",
      displayName: "Calendar",
    });
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(3);
  });
});
