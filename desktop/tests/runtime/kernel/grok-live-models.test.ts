import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../runtime/kernel/model-routing.js", () => ({
  readGrokCliSessionToken: () => undefined,
}));

import {
  getModel,
  getModels,
  unregisterModel,
} from "../../../../runtime/ai/models.js";
import { registerGrokLiveModels } from "../../../../runtime/kernel/grok-live-models.js";

const GROK = "grok" as never;

describe("registerGrokLiveModels", () => {
  const registeredIds: string[] = [];

  afterEach(() => {
    for (const id of registeredIds.splice(0)) {
      unregisterModel("grok", id);
    }
  });

  it("registers new live models cloned from the built-in template", () => {
    const template = (getModels(GROK) as Array<Record<string, unknown>>)[0];
    expect(template).toBeDefined();

    const registered = registerGrokLiveModels([
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        context_window: 500_000,
        supports_reasoning_effort: true,
      },
    ]);
    registeredIds.push("grok-4.5");

    expect(registered).toBe(1);
    const added = getModel(GROK, "grok-4.5" as never) as unknown as Record<
      string,
      unknown
    >;
    expect(added).toBeDefined();
    expect(added.name).toBe("Grok 4.5");
    expect(added.contextWindow).toBe(500_000);
    expect(added.reasoning).toBe(true);
    // Transport comes from the template; only the routing header is rewritten.
    expect(added.baseUrl).toBe(template.baseUrl);
    expect(added.api).toBe(template.api);
    expect(
      (added.headers as Record<string, string>)["x-grok-model-override"],
    ).toBe("grok-4.5");
  });

  it("skips ids already in the registry and blank ids", () => {
    const before = (getModels(GROK) as unknown[]).length;
    const existingId = (
      (getModels(GROK) as Array<Record<string, unknown>>)[0] as {
        id: string;
      }
    ).id;
    const registered = registerGrokLiveModels([
      { id: existingId, name: "Duplicate" },
      { id: "  ", name: "Blank" },
      {},
    ]);
    expect(registered).toBe(0);
    expect((getModels(GROK) as unknown[]).length).toBe(before);
  });
});
