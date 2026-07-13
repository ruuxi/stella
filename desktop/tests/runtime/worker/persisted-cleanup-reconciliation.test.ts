import { describe, expect, it, vi } from "vitest";
import {
  expireUnreconstructableAgentCleanups,
  reconcilePersistedAgentCleanups,
} from "../../../../runtime/worker/persisted-cleanup-reconciliation.js";

describe("persisted cleanup startup reconciliation", () => {
  it("expires unreconstructable records and returns the next durable deadline", () => {
    const reconcilePendingAgentCleanupRecords = vi.fn(() => ({
      clearedConversationIds: [],
      expiredConversationIds: ["conv-expired"],
    }));
    const notify = vi.fn();
    expect(
      expireUnreconstructableAgentCleanups({
        runtimeStore: {
          reconcilePendingAgentCleanupRecords,
          getNextPendingAgentCleanupExpiryAt: vi.fn(() => 9_000),
        },
        notifyThreadActivityUpdated: notify,
        now: 5_000,
        expiryMs: 1_000,
      }),
    ).toBe(9_000);
    expect(reconcilePendingAgentCleanupRecords).toHaveBeenCalledWith({
      resourcesVerifiedFree: false,
      now: 5_000,
      expiryMs: 1_000,
    });
    expect(notify).toHaveBeenCalledWith("conv-expired");
  });

  it("clears records only after force-resume and a verified-free status", async () => {
    const reconcilePendingAgentCleanupRecords = vi.fn(() => ({
      clearedConversationIds: ["conv-cleared"],
      expiredConversationIds: [],
    }));
    const notify = vi.fn();

    await expect(
      reconcilePersistedAgentCleanups({
        controller: {
          forceResumeAll: vi.fn(async () => true),
          getStatus: vi.fn(async () => ({
            paused: false,
            inFlightPaths: 0,
            appliedOverlayPaths: 0,
          })),
        },
        runtimeStore: {
          reconcilePendingAgentCleanupRecords,
          getNextPendingAgentCleanupExpiryAt: vi.fn(() => null),
        },
        notifyThreadActivityUpdated: notify,
        now: 5_000,
        expiryMs: 1_000,
      }),
    ).resolves.toBe(true);
    expect(reconcilePendingAgentCleanupRecords).toHaveBeenCalledWith({
      resourcesVerifiedFree: true,
      now: 5_000,
      expiryMs: 1_000,
    });
    expect(notify).toHaveBeenCalledWith("conv-cleared");
  });

  it("retains diagnostics when any HMR ownership remains pinned", async () => {
    const reconcilePendingAgentCleanupRecords = vi.fn(() => ({
      clearedConversationIds: [],
      expiredConversationIds: ["conv-expired"],
    }));
    const notify = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      reconcilePersistedAgentCleanups({
        controller: {
          forceResumeAll: vi.fn(async () => true),
          getStatus: vi.fn(async () => ({
            paused: false,
            inFlightPaths: 1,
            appliedOverlayPaths: 0,
          })),
        },
        runtimeStore: {
          reconcilePendingAgentCleanupRecords,
          getNextPendingAgentCleanupExpiryAt: vi.fn(() => null),
        },
        notifyThreadActivityUpdated: notify,
        now: 5_000,
        expiryMs: 1_000,
      }),
    ).resolves.toBe(false);
    expect(reconcilePendingAgentCleanupRecords).toHaveBeenCalledWith({
      resourcesVerifiedFree: false,
      now: 5_000,
      expiryMs: 1_000,
    });
    expect(notify).toHaveBeenCalledWith("conv-expired");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("persistent Activity diagnostics remain active"),
    );
  });
});
