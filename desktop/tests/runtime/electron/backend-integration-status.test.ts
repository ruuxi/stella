import { describe, expect, it } from "vitest";

import {
  probeBackendIntegrationConnection,
  waitForBackendIntegrationConnection,
} from "../../../../runtime/kernel/connectors/backend-integration-status.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const fetchSequence = (responses: Array<() => Response>) => {
  let index = 0;
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return next();
  }) as typeof fetch;
  return { fetchImpl, calls };
};

const baseOptions = {
  siteUrl: "https://backend.example/",
  authToken: "token-1",
  id: "notion",
};

describe("probeBackendIntegrationConnection", () => {
  it("reports connected only on an explicit true", async () => {
    const { fetchImpl } = fetchSequence([
      () => jsonResponse({ connected: true }),
    ]);
    expect(
      await probeBackendIntegrationConnection({ ...baseOptions, fetchImpl }),
    ).toBe("connected");
    const { fetchImpl: notYet } = fetchSequence([
      () => jsonResponse({ connected: false }),
    ]);
    expect(
      await probeBackendIntegrationConnection({
        ...baseOptions,
        fetchImpl: notYet,
      }),
    ).toBe("not_connected");
  });

  it("treats a missing endpoint as unsupported", async () => {
    const { fetchImpl } = fetchSequence([() => jsonResponse({}, 404)]);
    expect(
      await probeBackendIntegrationConnection({ ...baseOptions, fetchImpl }),
    ).toBe("unsupported");
  });

  it("reports transient failures as errors", async () => {
    const { fetchImpl } = fetchSequence([() => jsonResponse({}, 500)]);
    expect(
      await probeBackendIntegrationConnection({ ...baseOptions, fetchImpl }),
    ).toBe("error");
  });
});

describe("waitForBackendIntegrationConnection", () => {
  it("polls until the backend confirms the connection", async () => {
    const { fetchImpl, calls } = fetchSequence([
      () => jsonResponse({ connected: false }),
      () => jsonResponse({ connected: false }),
      () => jsonResponse({ connected: true }),
    ]);
    const result = await waitForBackendIntegrationConnection({
      ...baseOptions,
      fetchImpl,
      intervalMs: 1,
    });
    expect(result).toBe("connected");
    expect(calls.length).toBe(3);
    expect(calls[0]).toContain("/api/native-integrations/status?id=notion");
  });

  it("short-circuits to unsupported so callers fail closed", async () => {
    const { fetchImpl, calls } = fetchSequence([() => jsonResponse({}, 404)]);
    expect(
      await waitForBackendIntegrationConnection({
        ...baseOptions,
        fetchImpl,
        intervalMs: 1,
      }),
    ).toBe("unsupported");
    expect(calls.length).toBe(1);
  });

  it("times out when the user never completes OAuth", async () => {
    const { fetchImpl } = fetchSequence([
      () => jsonResponse({ connected: false }),
    ]);
    let clock = 0;
    const result = await waitForBackendIntegrationConnection({
      ...baseOptions,
      fetchImpl,
      intervalMs: 1,
      timeoutMs: 10,
      now: () => {
        clock += 6;
        return clock;
      },
    });
    expect(result).toBe("timeout");
  });

  it("fails closed when auth is unavailable — never polls, never reports connected", async () => {
    // Transient auth loss between connect-link creation and polling must
    // surface as a failure, not degrade into an optimistic success.
    const { fetchImpl, calls } = fetchSequence([
      () => jsonResponse({ connected: true }),
    ]);
    expect(
      await waitForBackendIntegrationConnection({
        ...baseOptions,
        authToken: "",
        fetchImpl,
        intervalMs: 1,
      }),
    ).toBe("auth_unavailable");
    expect(
      await waitForBackendIntegrationConnection({
        ...baseOptions,
        siteUrl: "   ",
        fetchImpl,
        intervalMs: 1,
      }),
    ).toBe("auth_unavailable");
    expect(calls.length).toBe(0);
  });

  it("cancels immediately when the abort signal fires", async () => {
    const controller = new AbortController();
    const { fetchImpl } = fetchSequence([
      () => jsonResponse({ connected: false }),
    ]);
    const pending = waitForBackendIntegrationConnection({
      ...baseOptions,
      fetchImpl,
      intervalMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    expect(await pending).toBe("cancelled");
  });
});
