import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  sweepStaleConnectorBridgeProcesses,
  writeConnectorBridgeProcessRecord,
  type ConnectorBridgeProcessRecord,
} from "../../../../../runtime/kernel/connectors/process-registry.js";

const roots: string[] = [];

const tempRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-connector-proc-"));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const record = (overrides: Partial<ConnectorBridgeProcessRecord> = {}) => ({
  sessionId: "session-1",
  pid: 2_147_483_647,
  ownerPid: process.pid,
  workerPid: process.pid,
  connectorId: "demo",
  displayName: "Demo",
  command: process.execPath,
  args: [],
  startedAt: Date.now(),
  processGroup: false,
  ...overrides,
});

describe("connector process registry", () => {
  it("removes records for dead connector helper pids", async () => {
    const root = tempRoot();
    const filePath = await writeConnectorBridgeProcessRecord(root, record());
    expect(filePath).toBeTruthy();

    const result = await sweepStaleConnectorBridgeProcesses(root, {
      currentWorkerPid: process.pid,
    });

    expect(result).toMatchObject({ scanned: 1, removed: 1, stopped: 0 });
    expect(existsSync(filePath!)).toBe(false);
  });

  it("keeps records still owned by the current worker", async () => {
    const root = tempRoot();
    const filePath = await writeConnectorBridgeProcessRecord(
      root,
      record({ pid: process.pid }),
    );
    expect(filePath).toBeTruthy();

    const result = await sweepStaleConnectorBridgeProcesses(root, {
      currentWorkerPid: process.pid,
    });

    expect(result).toMatchObject({ scanned: 1, removed: 0, stopped: 0 });
    expect(existsSync(filePath!)).toBe(true);
  });

  it("removes stale records without signaling when a pid was reused", async () => {
    const root = tempRoot();
    const filePath = await writeConnectorBridgeProcessRecord(
      root,
      record({
        pid: process.pid,
        ownerPid: 2_147_483_647,
        workerPid: 2_147_483_647,
        startedAt: Date.now() - 60_000,
      }),
    );
    expect(filePath).toBeTruthy();

    const result = await sweepStaleConnectorBridgeProcesses(root, {
      currentWorkerPid: process.pid,
    });

    expect(result).toMatchObject({ scanned: 1, removed: 1, stopped: 0 });
    expect(existsSync(filePath!)).toBe(false);
  });
});
