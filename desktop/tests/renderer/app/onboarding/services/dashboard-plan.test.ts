import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planDashboardPages } from "../../../../../src/global/onboarding/services/dashboard-plan";
import { createServiceRequest } from "@/infra/http/service-request";

vi.mock("@/infra/http/service-request", () => ({
  createServiceRequest: vi.fn(),
}));

describe("planDashboardPages", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(createServiceRequest).mockResolvedValue({
      endpoint: "https://test.convex.site/api/plan-dashboard-pages",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token",
        "X-Device-ID": "device-1",
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns pages on success", async () => {
    const pages = [
      {
        pageId: "one",
        title: "One",
        topic: "t1",
        focus: "f1",
        dataSources: ["a"],
        personalOrEntertainment: false,
      },
      {
        pageId: "two",
        title: "Two",
        topic: "t2",
        focus: "f2",
        dataSources: ["b"],
        personalOrEntertainment: true,
      },
      {
        pageId: "three",
        title: "Three",
        topic: "t3",
        focus: "f3",
        dataSources: ["c"],
        personalOrEntertainment: false,
      },
    ];
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ pages }), { status: 200 }),
    );

    const result = await planDashboardPages("[who] tester", true);
    expect(result).toEqual(pages);
  });

  it("calls plan endpoint with coreMemory only", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          pages: [
            {
              pageId: "a",
              title: "A",
              topic: "t",
              focus: "f",
              dataSources: [],
              personalOrEntertainment: true,
            },
            {
              pageId: "b",
              title: "B",
              topic: "t",
              focus: "f",
              dataSources: [],
              personalOrEntertainment: false,
            },
            {
              pageId: "c",
              title: "C",
              topic: "t",
              focus: "f",
              dataSources: [],
              personalOrEntertainment: false,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await planDashboardPages("profile text", false);

    expect(createServiceRequest).toHaveBeenCalledWith(
      "/api/plan-dashboard-pages",
      { "Content-Type": "application/json" },
      { includeAuth: false },
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://test.convex.site/api/plan-dashboard-pages",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"coreMemory":"profile text"'),
      }),
    );
  });

  it("throws when pages missing", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await expect(planDashboardPages("x", true)).rejects.toThrow(
      "Dashboard plan returned invalid pages",
    );
  });
});
