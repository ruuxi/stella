import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyUserProfileOperation,
  parseUserProfileEntries,
  readUserProfile,
  userProfilePath,
} from "../../../../../runtime/kernel/memory/user-profile-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "stella-user-profile-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const entries = async (): Promise<string[]> => {
  const content = await readUserProfile(dir);
  return content ? parseUserProfileEntries(content) : [];
};

describe("user-profile-store", () => {
  it("adds a durable fact and persists it under memories/profile.md", async () => {
    const result = await applyUserProfileOperation(dir, {
      action: "add",
      content: "The user goes by Bob",
    });
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(1);
    expect(userProfilePath(dir)).toBe(
      path.join(dir, "memories", "profile.md"),
    );
    expect(await entries()).toEqual(["The user goes by Bob"]);
  });

  it("dedupes case-insensitively without erroring", async () => {
    await applyUserProfileOperation(dir, {
      action: "add",
      content: "The user lives in Berlin",
    });
    const dup = await applyUserProfileOperation(dir, {
      action: "add",
      content: "the user lives in berlin",
    });
    expect(dup.ok).toBe(true);
    expect(dup.message).toMatch(/already/i);
    expect(await entries()).toHaveLength(1);
  });

  it("replaces an outdated fact matched loosely", async () => {
    await applyUserProfileOperation(dir, {
      action: "add",
      content: "The user lives in Berlin",
    });
    const replaced = await applyUserProfileOperation(dir, {
      action: "replace",
      oldContent: "lives in Berlin",
      content: "The user lives in Lisbon",
    });
    expect(replaced.ok).toBe(true);
    expect(await entries()).toEqual(["The user lives in Lisbon"]);
  });

  it("removes a fact", async () => {
    await applyUserProfileOperation(dir, {
      action: "add",
      content: "The user dislikes phone calls",
    });
    const removed = await applyUserProfileOperation(dir, {
      action: "remove",
      content: "dislikes phone calls",
    });
    expect(removed.ok).toBe(true);
    expect(await entries()).toEqual([]);
  });

  it("reports a clear error when there is nothing to replace", async () => {
    const result = await applyUserProfileOperation(dir, {
      action: "replace",
      oldContent: "nonexistent",
      content: "whatever",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no matching/i);
  });

  it("rejects adds that would exceed the size cap", async () => {
    let added = 0;
    for (let i = 0; i < 200; i += 1) {
      const result = await applyUserProfileOperation(dir, {
        action: "add",
        content: `Durable fact number ${i} about the user and their stable long-running preferences`,
      });
      if (result.ok && result.message === "Remembered.") added += 1;
      else if (!result.ok) {
        expect(result.message).toMatch(/full/i);
        break;
      }
    }
    expect(added).toBeGreaterThan(0);
    // Some adds must have been rejected by the cap.
    expect(added).toBeLessThan(200);
  });

  it("keeps both facts when two adds run concurrently", async () => {
    const [first, second] = await Promise.all([
      applyUserProfileOperation(dir, {
        action: "add",
        content: "The user goes by Bob",
      }),
      applyUserProfileOperation(dir, {
        action: "add",
        content: "The user lives in Berlin",
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const stored = await entries();
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(
      expect.arrayContaining([
        "The user goes by Bob",
        "The user lives in Berlin",
      ]),
    );
  });

  it("redacts secrets in stored facts", async () => {
    await applyUserProfileOperation(dir, {
      action: "add",
      content: "The user's API key is sk-abcdef0123456789abcdef0123456789",
    });
    const stored = (await readUserProfile(dir)) ?? "";
    expect(stored).not.toContain("sk-abcdef0123456789abcdef0123456789");
  });
});
