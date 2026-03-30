import { describe, expect, it } from "vitest";
import { parseGoogleWorkspaceProfile } from "../../../../packages/runtime-kernel/runner.js";

describe("parseGoogleWorkspaceProfile", () => {
  it("reads the authenticated account from People API nested fields", () => {
    expect(
      parseGoogleWorkspaceProfile({
        name: "people/123456789",
        names: [{ displayName: "Ada Lovelace" }],
        emailAddresses: [{ value: "ada@example.com" }],
      }),
    ).toEqual({
      email: "ada@example.com",
      name: "Ada Lovelace",
    });
  });

  it("does not treat the People API resource name as the display name", () => {
    expect(
      parseGoogleWorkspaceProfile({
        name: "people/123456789",
        emailAddresses: [{ value: "ada@example.com" }],
      }),
    ).toEqual({
      email: "ada@example.com",
      name: undefined,
    });
  });
});
