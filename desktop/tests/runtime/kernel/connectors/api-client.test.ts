import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { callApiConnector } from "../../../../../runtime/kernel/connectors/api-client.js";
import { saveConnectorAccessToken } from "../../../../../runtime/kernel/connectors/oauth.js";

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

const roots: string[] = [];
const originalDevStorage = process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE;

beforeEach(() => {
  process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE = "1";
});

afterEach(async () => {
  if (originalDevStorage === undefined) {
    delete process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE;
  } else {
    process.env.STELLA_DEV_INSECURE_PROTECTED_STORAGE = originalDevStorage;
  }
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

const createRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-api-client-"));
  roots.push(root);
  return root;
};

const startServer = async (
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    baseUrl: string,
  ) => void,
): Promise<TestServer> => {
  let baseUrl = "";
  const server = http.createServer((req, res) => handler(req, res, baseUrl));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

describe("connector API client", () => {
  it("keeps slash-prefixed calls under versioned API base paths", async () => {
    const root = createRoot();
    await saveConnectorAccessToken(root, "cal-demo", "cal-access");

    const server = await startServer((req, res) => {
      expect(req.url).toBe("/v2/bookings?limit=10");
      expect(req.headers.authorization).toBe("Bearer cal-access");
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true }),
      );
    });

    try {
      await expect(
        callApiConnector(
          root,
          {
            id: "cal",
            displayName: "Cal",
            baseUrl: `${server.baseUrl}/v2`,
            auth: {
              type: "oauth",
              tokenKey: "cal-demo",
            },
          },
          {
            path: "/bookings",
            query: { limit: 10 },
          },
        ),
      ).resolves.toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });

  it("keeps relative calls under versioned API base paths", async () => {
    const root = createRoot();

    const server = await startServer((req, res) => {
      expect(req.url).toBe("/api/v0/public/tasks");
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ ok: true }),
      );
    });

    try {
      await expect(
        callApiConnector(
          root,
          {
            id: "dart",
            displayName: "Dart",
            baseUrl: `${server.baseUrl}/api/v0/public`,
            auth: {
              type: "none",
            },
          },
          {
            path: "tasks",
          },
        ),
      ).resolves.toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });

  it("rejects absolute calls that leave the connector origin", async () => {
    const root = createRoot();

    await expect(
      callApiConnector(
        root,
        {
          id: "demo",
          displayName: "Demo",
          baseUrl: "https://api.example.com/v1",
          auth: {
            type: "none",
          },
        },
        {
          path: "https://evil.example.com/steal",
        },
      ),
    ).rejects.toThrow("connector base URL");
  });

  it("rejects same-origin absolute calls that leave the connector base path", async () => {
    const root = createRoot();

    await expect(
      callApiConnector(
        root,
        {
          id: "cal",
          displayName: "Cal",
          baseUrl: "https://api.example.com/v2",
          auth: {
            type: "none",
          },
        },
        {
          path: "https://api.example.com/v1/bookings",
        },
      ),
    ).rejects.toThrow("connector base URL");
  });

  it("rejects same-origin absolute calls that only share a base path prefix", async () => {
    const root = createRoot();

    await expect(
      callApiConnector(
        root,
        {
          id: "cal",
          displayName: "Cal",
          baseUrl: "https://api.example.com/v2",
          auth: {
            type: "none",
          },
        },
        {
          path: "https://api.example.com/v20/bookings",
        },
      ),
    ).rejects.toThrow("connector base URL");
  });
});
