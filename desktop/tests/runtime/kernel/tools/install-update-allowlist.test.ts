import { describe, expect, it } from "vitest";
import { getInstallUpdateCommandDenialReason } from "../../../../../runtime/kernel/tools/install-update-allowlist.js";

describe("install-update command allowlist", () => {
  it("allows the root dependency install used after package updates", () => {
    expect(getInstallUpdateCommandDenialReason("bun install")).toBeNull();
    expect(
      getInstallUpdateCommandDenialReason("bun install --frozen-lockfile"),
    ).toBeNull();
  });

  it("keeps install-update dependency access narrow", () => {
    expect(getInstallUpdateCommandDenialReason("bun add react")).toContain(
      "only git commands",
    );
    expect(
      getInstallUpdateCommandDenialReason("bun install --production"),
    ).toContain("only git commands");
    expect(
      getInstallUpdateCommandDenialReason(
        "bun install --frozen-lockfile && git status",
      ),
    ).toContain("single git invocation");
  });

  it("still allows the expected git merge workflow", () => {
    expect(
      getInstallUpdateCommandDenialReason(
        "git fetch --filter=blob:none --no-tags origin abc123",
      ),
    ).toBeNull();
    expect(
      getInstallUpdateCommandDenialReason(
        "git merge --no-edit -m Update abc123",
      ),
    ).toBeNull();
  });
});
