import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireRepoMutationEpoch } from "../../../../../runtime/kernel/self-mod/mutation-epoch.js";

describe("self-mod mutation epoch", () => {
  it("serializes vanilla mutation owners for the same checkout", async () => {
    const repo = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-mutation-epoch-"),
    );
    try {
      const releaseFirst = await acquireRepoMutationEpoch(repo);
      let secondAcquired = false;
      const second = acquireRepoMutationEpoch(repo).then((release) => {
        secondAcquired = true;
        return release;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(secondAcquired).toBe(false);

      await releaseFirst();
      const releaseSecond = await second;
      expect(secondAcquired).toBe(true);
      await releaseSecond();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not serialize independent checkouts", async () => {
    const left = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-mutation-epoch-left-"),
    );
    const right = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-mutation-epoch-right-"),
    );
    try {
      const releaseLeft = await acquireRepoMutationEpoch(left);
      const releaseRight = await acquireRepoMutationEpoch(right);
      await releaseRight();
      await releaseLeft();
    } finally {
      fs.rmSync(left, { recursive: true, force: true });
      fs.rmSync(right, { recursive: true, force: true });
    }
  });

  it("reclaims only an immutable stale ticket, never a successor lease path", async () => {
    const repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "stella-mutation-stale-ticket-")),
    );
    const hash = crypto.createHash("sha256").update(repo).digest("hex");
    const lockDirectory = path.join(
      os.tmpdir(),
      `stella-self-mod-mutation-${hash.slice(0, 24)}.lock.d`,
    );
    fs.mkdirSync(lockDirectory, { recursive: true });
    const staleTicket = path.join(
      lockDirectory,
      "0000000000000-dead-owner.ticket",
    );
    fs.writeFileSync(
      staleTicket,
      JSON.stringify({ pid: 2_147_483_647, token: "dead-owner" }),
    );
    try {
      const release = await acquireRepoMutationEpoch(repo);
      expect(fs.existsSync(staleTicket)).toBe(false);
      await release();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(lockDirectory, { recursive: true, force: true });
    }
  });
});
