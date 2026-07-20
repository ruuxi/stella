import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getModelConfigCommandInvocation,
  getRemoteCatalogModelValidationErrors,
  isRemoteCatalogModel,
} from "../../../../runtime/ai/model-config.js";
import {
  mergeModelHeaders,
  ModelRuntime,
} from "../../../../runtime/ai/model-runtime.js";
import { getOAuthProvider } from "../../../../runtime/ai/utils/oauth/index.js";
import azureOpenAIResponsesCatalog from "../../fixtures/azure-openai-responses-catalog.json";
import openRouterAutoCatalog from "../../fixtures/openrouter-auto-catalog.json";

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "stella-model-runtime-"),
  );
  tempDirs.push(directory);
  return directory;
};

const validRemoteCatalogModel = (overrides: Record<string, unknown> = {}) => ({
  id: "grok-remote-valid",
  name: "Grok Remote Valid",
  api: "openai-responses",
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 500_000,
  maxTokens: 100_000,
  ...overrides,
});

const refreshXaiCatalog = async (
  buildEntries: (runtime: ModelRuntime) => unknown[],
): Promise<ModelRuntime> => {
  const stellaDataDir = await makeTempDir();
  const runtime = new ModelRuntime();
  await runtime.initialize({ stellaDataDir, allowNetwork: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/xai")) {
      return new Response(JSON.stringify({ models: buildEntries(runtime) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    await runtime.getSnapshotForListing({ forceRefresh: true });
    return runtime;
  } finally {
    globalThis.fetch = originalFetch;
  }
};

afterEach(async () => {
  delete process.env.STELLA_TEST_MODEL_KEY;
  delete process.env.STELLA_MISSING_MODEL_HEADER;
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ModelRuntime", () => {
  it("does not register retired Google subscription OAuth providers", () => {
    expect(getOAuthProvider("google-gemini-cli")).toBeUndefined();
    expect(getOAuthProvider("google-antigravity")).toBeUndefined();
  });

  it("uses the platform shell contract for models.json commands", () => {
    expect(
      getModelConfigCommandInvocation("echo configured-token", {
        platform: "win32",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      }),
    ).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "echo configured-token"],
    });
    expect(
      getModelConfigCommandInvocation("echo configured-token", {
        platform: "win32",
        env: {},
      }),
    ).toEqual({
      executable: "cmd.exe",
      args: ["/d", "/s", "/c", "echo configured-token"],
    });
    expect(
      getModelConfigCommandInvocation("printf configured-token", {
        platform: "linux",
        env: { SHELL: "/bin/zsh" },
      }),
    ).toEqual({
      executable: "/bin/zsh",
      args: ["-lc", "printf configured-token"],
    });
    expect(
      getModelConfigCommandInvocation("printf configured-token", {
        platform: "darwin",
        env: {},
      }),
    ).toEqual({
      executable: "/bin/sh",
      args: ["-lc", "printf configured-token"],
    });
  });

  it("registers xAI device OAuth and refreshes subscription tokens", async () => {
    const provider = getOAuthProvider("xai");
    expect(provider?.name).toBe("xAI (Grok/X subscription)");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3_600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const refreshed = await provider?.refreshToken({
        access: "old-access",
        refresh: "old-refresh",
        expires: 0,
      });
      expect(refreshed).toMatchObject({
        access: "new-access",
        refresh: "new-refresh",
      });
      expect(refreshed?.expires).toBeGreaterThan(Date.now());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces an xAI device code when the authorization URL cannot embed it", async () => {
    const provider = getOAuthProvider("xai");
    const onAuth = vi.fn();
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(
          JSON.stringify({
            device_code: "device-code",
            user_code: "ABCD-EFGH",
            verification_uri: "https://auth.x.ai/activate",
            interval: 0.001,
            expires_in: 30,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3_600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      await provider?.login({
        onAuth,
        onPrompt: async () => "",
      });
      expect(onAuth).toHaveBeenCalledWith({
        url: "https://auth.x.ai/activate",
        instructions: "Confirm code ABCD-EFGH",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("composes models.json, extensions, and top-level model overrides", async () => {
    const stellaDataDir = await makeTempDir();
    process.env.STELLA_TEST_MODEL_KEY = "configured-secret";
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      `{
        // JSONC comments, URLs, and trailing commas match Pi's models.json.
        "providers": {
          "custom": {
            "api": "openai-completions",
            "baseUrl": "http://127.0.0.1:11434/v1",
            "apiKey": "$STELLA_TEST_MODEL_KEY",
            "headers": { "X-Provider": "$STELLA_TEST_MODEL_KEY" },
            "models": [{
              "id": "custom-model",
              "name": "Configured \\"model\\"",
              "headers": { "X-Model": "$STELLA_TEST_MODEL_KEY" },
            }],
            "modelOverrides": {
              "custom-model": {
                "name": "User override",
                "headers": { "X-Override": "$STELLA_TEST_MODEL_KEY" },
              },
            },
          },
        },
      }`,
    );

    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });
    runtime.setExtensionProviders([
      {
        name: "custom",
        api: "openai-completions",
        baseUrl: "https://extension.example/v1",
        models: [
          {
            id: "custom-model",
            name: "Extension model",
            contextWindow: 64_000,
            maxTokens: 8_192,
          },
        ],
      },
      {
        name: "extension-only",
        api: "openai-completions",
        baseUrl: "https://extension-only.example/v1",
        models: [
          {
            id: "extension-model",
            name: "Extension model",
            contextWindow: 64_000,
            maxTokens: 8_192,
          },
        ],
      },
    ]);

    expect(runtime.getModel("custom", "custom-model")).toMatchObject({
      name: "User override",
      baseUrl: "https://extension.example/v1",
      provider: "custom",
    });
    expect(runtime.getConfiguredApiKey("custom")).toBe("configured-secret");
    expect(runtime.getConfiguredHeaders("custom", "custom-model")).toEqual({
      "X-Provider": "configured-secret",
      "X-Model": "configured-secret",
      "X-Override": "configured-secret",
    });
    expect(runtime.getSnapshot().runtimeManagedProviders).toContainEqual({
      id: "extension-only",
      authManaged: false,
      credentialless: true,
    });
  });

  it("only treats extensions with explicit auth as runtime-auth managed", async () => {
    const stellaDataDir = await makeTempDir();
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });
    const baseProvider = {
      name: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      models: [
        {
          id: "extension-openai-model",
          name: "Extension OpenAI model",
          contextWindow: 128_000,
          maxTokens: 16_000,
        },
      ],
    };

    runtime.setExtensionProviders([baseProvider]);
    expect(runtime.hasRuntimeManagedAuth("openai")).toBe(false);
    expect(runtime.getSnapshot().runtimeManagedProviders).toContainEqual({
      id: "openai",
      authManaged: false,
      credentialless: false,
    });

    process.env.STELLA_TEST_MODEL_KEY = "extension-token";
    runtime.setExtensionProviders([
      { ...baseProvider, apiKeyEnv: "STELLA_TEST_MODEL_KEY" },
    ]);
    expect(runtime.hasRuntimeManagedAuth("openai")).toBe(true);
    expect(runtime.allowsCredentiallessRouting("openai")).toBe(false);
    expect(runtime.getRuntimeManagedApiKey("openai")).toBe("extension-token");

    runtime.setExtensionProviders([
      {
        ...baseProvider,
        headers: { Authorization: "Bearer extension-static-token" },
      },
    ]);
    expect(runtime.hasRuntimeManagedAuth("openai")).toBe(true);
    expect(runtime.getRuntimeManagedApiKey("openai")).toBeUndefined();
    expect(runtime.allowsCredentiallessRouting("xai")).toBe(false);
  });

  it("allows only origin-verified custom providers to route credentiallessly", async () => {
    const stellaDataDir = await makeTempDir();
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          "local-proxy": {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:4141/v1",
            models: [{ id: "proxy-model" }],
          },
        },
      }),
    );
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });

    expect(runtime.allowsCredentiallessRouting("local-proxy")).toBe(true);
    expect(runtime.getSnapshot().runtimeManagedProviders).toContainEqual({
      id: "local-proxy",
      authManaged: false,
      credentialless: true,
    });
    expect(runtime.allowsCredentiallessRouting("xai")).toBe(false);
    expect(runtime.allowsCredentiallessRouting("unknown-provider")).toBe(
      false,
    );
  });

  it("does not treat authHeader providers without a key as credentialless", async () => {
    const stellaDataDir = await makeTempDir();
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          "auth-required-proxy": {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:4141/v1",
            authHeader: true,
            models: [{ id: "proxy-model" }],
          },
        },
      }),
    );
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });

    expect(runtime.hasRuntimeProviderOrigin("auth-required-proxy")).toBe(true);
    expect(runtime.hasRuntimeManagedAuth("auth-required-proxy")).toBe(false);
    expect(runtime.allowsCredentiallessRouting("auth-required-proxy")).toBe(
      false,
    );
    expect(runtime.getSnapshot().runtimeManagedProviders).toContainEqual({
      id: "auth-required-proxy",
      authManaged: false,
      credentialless: false,
    });
  });

  it("fails closed when a configured API key expression is unresolved", async () => {
    const stellaDataDir = await makeTempDir();
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          "missing-key-proxy": {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:4141/v1",
            apiKey: "$STELLA_MISSING_MODEL_HEADER",
            models: [{ id: "proxy-model" }],
          },
        },
      }),
    );
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });

    expect(runtime.hasConfiguredApiKey("missing-key-proxy")).toBe(false);
    expect(runtime.hasRuntimeManagedAuth("missing-key-proxy")).toBe(true);
    expect(runtime.allowsCredentiallessRouting("missing-key-proxy")).toBe(
      false,
    );
    expect(runtime.getSnapshot().runtimeManagedProviders).toContainEqual({
      id: "missing-key-proxy",
      authManaged: true,
      credentialless: false,
    });
    expect(() => runtime.getRuntimeManagedApiKey("missing-key-proxy")).toThrow(
      /Required models\.json API key for provider "missing-key-proxy" could not be resolved/u,
    );
  });

  it("tracks models.json and extension Moonshot providers as direct origins", async () => {
    const stellaDataDir = await makeTempDir();
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          moonshotai: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:4141/v1",
            models: [{ id: "config-moonshot" }],
          },
        },
      }),
    );
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });
    expect(runtime.hasRuntimeProviderOrigin("moonshotai")).toBe(true);
    expect(runtime.allowsCredentiallessRouting("moonshotai")).toBe(true);

    const extensionRuntime = new ModelRuntime();
    await extensionRuntime.initialize({
      stellaDataDir: await makeTempDir(),
      allowNetwork: false,
    });
    extensionRuntime.setExtensionProviders([
      {
        name: "moonshotai",
        api: "openai-completions",
        baseUrl: "https://extension.moonshot.test/v1",
        apiKeyEnv: "STELLA_TEST_MODEL_KEY",
        models: [
          {
            id: "extension-moonshot",
            name: "Extension Moonshot",
            contextWindow: 128_000,
            maxTokens: 16_000,
          },
        ],
      },
    ]);
    expect(extensionRuntime.hasRuntimeProviderOrigin("moonshotai")).toBe(true);
    expect(extensionRuntime.allowsCredentiallessRouting("moonshotai")).toBe(
      false,
    );
  });

  it("publishes changed extension, managed, and models.json snapshots once", async () => {
    const stellaDataDir = await makeTempDir();
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });
    const snapshots: ReturnType<ModelRuntime["getSnapshot"]>[] = [];
    const unsubscribe = runtime.onCatalogChanged((snapshot) => {
      snapshots.push(snapshot);
    });
    const extension = {
      name: "hot-provider",
      api: "openai-completions",
      baseUrl: "https://hot.example/v1",
      models: [
        {
          id: "hot-one",
          name: "Hot One",
          contextWindow: 64_000,
          maxTokens: 8_000,
        },
      ],
    };

    try {
      runtime.setExtensionProviders([extension]);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.models).toContainEqual(
        expect.objectContaining({ provider: "hot-provider", id: "hot-one" }),
      );

      runtime.setExtensionProviders([extension]);
      expect(snapshots).toHaveLength(1);

      runtime.setExtensionProviders([
        {
          ...extension,
          models: [
            {
              ...extension.models[0],
              id: "hot-two",
              name: "Hot Two",
            },
          ],
        },
      ]);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1]?.models).toContainEqual(
        expect.objectContaining({ provider: "hot-provider", id: "hot-two" }),
      );

      runtime.setManagedProviderModels("stella", [
        {
          id: "managed-hot",
          name: "Managed Hot",
          api: "openai-completions",
          provider: "stella",
          baseUrl: "https://stella.example/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_000,
        },
      ]);
      expect(snapshots).toHaveLength(3);

      await writeFile(
        path.join(stellaDataDir, "models.json"),
        JSON.stringify({ providers: { broken: { models: [null] } } }),
      );
      await runtime.reloadConfig();
      expect(snapshots).toHaveLength(4);
      expect(snapshots[3]?.configError).toMatch(/models\.json/iu);
      expect(snapshots.map((snapshot) => snapshot.revision)).toEqual(
        [...snapshots]
          .map((snapshot) => snapshot.revision)
          .sort((a, b) => a - b),
      );
    } finally {
      unsubscribe();
    }
  });

  it("inherits built-in transport and defaults for an id-only model definition", async () => {
    const stellaDataDir = await makeTempDir();
    const runtime = new ModelRuntime();
    const builtin = runtime.getModels("xai")[0];
    expect(builtin).toBeDefined();
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          xai: { models: [{ id: builtin.id }] },
        },
      }),
    );

    await expect(
      runtime.initialize({ stellaDataDir, allowNetwork: false }),
    ).resolves.toBeUndefined();
    expect(runtime.getModel("xai", builtin.id)).toMatchObject({
      name: builtin.name,
      api: builtin.api,
      baseUrl: builtin.baseUrl,
      reasoning: builtin.reasoning,
      thinkingLevelMap: builtin.thinkingLevelMap,
      cost: builtin.cost,
      contextWindow: builtin.contextWindow,
      maxTokens: builtin.maxTokens,
    });
    expect(runtime.getSnapshot().configError).toBeUndefined();
  });

  it("uses only transport defaults for an unmatched id-only model", async () => {
    const stellaDataDir = await makeTempDir();
    const runtime = new ModelRuntime();
    const providerTransport = runtime.getModels("xai")[0];
    expect(providerTransport).toBeDefined();
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          xai: { models: [{ id: "custom-id-only" }] },
        },
      }),
    );

    await runtime.initialize({ stellaDataDir, allowNetwork: false });
    expect(runtime.getModel("xai", "custom-id-only")).toEqual({
      id: "custom-id-only",
      name: "custom-id-only",
      api: providerTransport.api,
      provider: "xai",
      baseUrl: providerTransport.baseUrl,
      reasoning: false,
      thinkingLevelMap: undefined,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
      headers: undefined,
      compat: undefined,
    });
  });

  it("preserves baseline headers only for a matching model definition", async () => {
    const stellaDataDir = await makeTempDir();
    const runtime = new ModelRuntime();
    const baseline = runtime
      .getAllModels()
      .find((model) => Object.keys(model.headers ?? {}).length > 0);
    expect(baseline).toBeDefined();
    if (!baseline) throw new Error("Expected a built-in model with headers");
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          [baseline.provider]: {
            models: [
              {
                id: baseline.id,
                headers: {
                  "user-agent": "configured-agent",
                  "X-Configured": "configured-value",
                },
              },
            ],
          },
        },
      }),
    );

    await runtime.initialize({ stellaDataDir, allowNetwork: false });
    const configured = runtime.getModel(baseline.provider, baseline.id);
    expect(configured?.headers).toEqual(baseline.headers);
    const requestHeaders = runtime.getConfiguredHeaders(
      baseline.provider,
      baseline.id,
    );
    expect(requestHeaders).toEqual({
      "user-agent": "configured-agent",
      "X-Configured": "configured-value",
    });
    const merged = mergeModelHeaders(configured?.headers, requestHeaders);
    expect(
      Object.keys(merged ?? {}).filter(
        (name) => name.toLowerCase() === "user-agent",
      ),
    ).toHaveLength(1);
    expect(
      Object.entries(merged ?? {}).find(
        ([name]) => name.toLowerCase() === "user-agent",
      )?.[1],
    ).toBe("configured-agent");
  });

  it("publishes an initialized snapshot even when the registry is unchanged", async () => {
    const stellaDataDir = await makeTempDir();
    const runtime = new ModelRuntime();
    const before = runtime.getSnapshot();
    const snapshots: ReturnType<ModelRuntime["getSnapshot"]>[] = [];
    const unsubscribe = runtime.onCatalogChanged((snapshot) => {
      snapshots.push(snapshot);
    });
    try {
      await runtime.initialize({ stellaDataDir, allowNetwork: false });
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.revision).toBeGreaterThan(before.revision);
      expect(snapshots[0]?.models).toEqual(before.models);
      expect(snapshots[0]?.runtimeManagedProviders).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("falls back to built-ins and reports invalid schema or composition", async () => {
    for (const providers of [
      { broken: { models: [null] } },
      { broken: { models: [{ id: "orphan" }] } },
    ]) {
      const stellaDataDir = await makeTempDir();
      await writeFile(
        path.join(stellaDataDir, "models.json"),
        JSON.stringify({ providers }),
      );
      const runtime = new ModelRuntime();
      await expect(
        runtime.initialize({ stellaDataDir, allowNetwork: false }),
      ).resolves.toBeUndefined();
      expect(runtime.getSnapshot().configError).toMatch(/models\.json/iu);
      expect(runtime.getModels("xai").length).toBeGreaterThan(0);
      expect(runtime.getModels("broken")).toEqual([]);
    }
  });

  it("isolates composition failures to the invalid provider", async () => {
    const stellaDataDir = await makeTempDir();
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          valid: {
            api: "openai-completions",
            baseUrl: "https://valid.example/v1",
            apiKey: "valid-key",
            models: [{ id: "valid-model" }],
          },
          broken: {
            apiKey: "broken-key",
            models: [{ id: "broken-model" }],
          },
        },
      }),
    );
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });

    expect(runtime.getModel("valid", "valid-model")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://valid.example/v1",
    });
    expect(runtime.getModels("broken")).toEqual([]);
    expect(runtime.getSnapshot().configError).toMatch(
      /Provider "broken".*requires api and baseUrl/u,
    );
    expect(runtime.getSnapshot().runtimeManagedProviders).toContainEqual({
      id: "valid",
      authManaged: true,
      credentialless: false,
    });
    expect(runtime.hasConfiguredApiKey("broken")).toBe(false);
    expect(
      runtime
        .getSnapshot()
        .runtimeManagedProviders.some((provider) => provider.id === "broken"),
    ).toBe(false);
  });

  it("checks command auth without executing and resolves it once on demand", async () => {
    const stellaDataDir = await makeTempDir();
    const counterPath = path.join(stellaDataDir, "counter.txt");
    const command = `!count=$(cat ${JSON.stringify(counterPath)} 2>/dev/null || printf 0); count=$((count+1)); printf %s "$count" > ${JSON.stringify(counterPath)}; printf configured-token`;
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://example.test/v1",
            apiKey: command,
            authHeader: true,
            headers: { "X-Static": "value" },
            models: [{ id: "custom-model" }],
          },
        },
      }),
    );
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });

    expect(runtime.hasConfiguredApiKey("custom")).toBe(true);
    expect(runtime.getConfiguredHeaders("custom", "custom-model")).toEqual({
      "X-Static": "value",
    });
    await expect(readFile(counterPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runtime.getConfiguredApiKey("custom")).toBe("configured-token");
    expect(await readFile(counterPath, "utf8")).toBe("1");
    expect(runtime.getSnapshot().runtimeManagedProviders).toContainEqual({
      id: "custom",
      authManaged: true,
      credentialless: false,
    });
  });

  it("never leaves unresolved model override headers on routed metadata", async () => {
    const stellaDataDir = await makeTempDir();
    const runtime = new ModelRuntime();
    const builtin = runtime.getModels("xai")[0];
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          xai: {
            modelOverrides: {
              [builtin.id]: {
                headers: { "X-Secret": "$STELLA_MISSING_MODEL_HEADER" },
              },
            },
          },
        },
      }),
    );
    await runtime.initialize({ stellaDataDir, allowNetwork: false });

    expect(runtime.getModel("xai", builtin.id)?.headers?.["X-Secret"]).toBe(
      undefined,
    );
    expect(() => runtime.getConfiguredHeaders("xai", builtin.id)).toThrow(
      new RegExp(
        `Required models\\.json header "X-Secret" for model "xai/${builtin.id}" could not be resolved`,
        "u",
      ),
    );
  });

  it("fails closed when a required header command fails", async () => {
    const stellaDataDir = await makeTempDir();
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://example.test/v1",
            apiKey: "configured-key",
            headers: { "X-Required": "!exit 17" },
            models: [{ id: "custom-model" }],
          },
        },
      }),
    );
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });

    expect(() =>
      runtime.getConfiguredHeaders("custom", "custom-model"),
    ).toThrow(
      /Required models\.json header "X-Required" for provider "custom" could not be resolved/u,
    );
  });

  it("merges configured headers case-insensitively", async () => {
    const stellaDataDir = await makeTempDir();
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://example.test/v1",
            apiKey: "configured-key",
            headers: { authorization: "provider-value" },
            models: [
              {
                id: "custom-model",
                headers: { Authorization: "model-value" },
              },
            ],
            modelOverrides: {
              "custom-model": {
                headers: { AUTHORIZATION: "override-value" },
              },
            },
          },
        },
      }),
    );
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });

    expect(runtime.getConfiguredHeaders("custom", "custom-model")).toEqual({
      Authorization: "override-value",
    });
  });

  it("deep-merges partial thinking and nested compat overrides", async () => {
    const stellaDataDir = await makeTempDir();
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://example.test/v1",
            models: [
              {
                id: "custom-model",
                thinkingLevelMap: { low: "low-base", high: "high-base" },
                compat: {
                  openRouterRouting: {
                    allow_fallbacks: true,
                    order: ["base"],
                  },
                  vercelGatewayRouting: {
                    only: ["base"],
                    order: ["base"],
                  },
                  chatTemplateKwargs: {
                    enabled: { $var: "thinking.enabled" },
                    preserve_thinking: true,
                  },
                },
              },
            ],
            modelOverrides: {
              "custom-model": {
                thinkingLevelMap: { high: "high-override" },
                compat: {
                  openRouterRouting: { only: ["override"] },
                  vercelGatewayRouting: { order: ["override"] },
                  chatTemplateKwargs: { preserve_thinking: false },
                },
              },
            },
          },
        },
      }),
    );
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });

    expect(runtime.getModel("custom", "custom-model")).toMatchObject({
      thinkingLevelMap: { low: "low-base", high: "high-override" },
      compat: {
        openRouterRouting: {
          allow_fallbacks: true,
          order: ["base"],
          only: ["override"],
        },
        vercelGatewayRouting: {
          only: ["base"],
          order: ["override"],
        },
        chatTemplateKwargs: {
          enabled: { $var: "thinking.enabled" },
          preserve_thinking: false,
        },
      },
    });
  });

  it("persists and serves pi.dev provider catalog overlays", async () => {
    const stellaDataDir = await makeTempDir();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/xai")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                id: "grok-next",
                name: "Grok Next",
                provider: "xai",
                api: "openai-responses",
                baseUrl: "https://api.x.ai/v1",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 500_000,
                maxTokens: 100_000,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    try {
      const runtime = new ModelRuntime();
      await runtime.initialize({ stellaDataDir, allowNetwork: true });
      expect(runtime.getModel("xai", "grok-next")?.name).toBe("Grok Next");

      const restored = new ModelRuntime();
      await restored.initialize({ stellaDataDir, allowNetwork: false });
      expect(restored.getModel("xai", "grok-next")?.name).toBe("Grok Next");
      expect(
        restored.getSnapshot().models.every((model) => !("headers" in model)),
      ).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts and composes the captured 46-entry Azure Responses catalog", async () => {
    const entries = Object.values(azureOpenAIResponsesCatalog);
    expect(entries).toHaveLength(46);
    expect(
      entries.every(
        (entry) =>
          entry.api === "azure-openai-responses" && entry.baseUrl === "",
      ),
    ).toBe(true);
    expect(entries.every(isRemoteCatalogModel)).toBe(true);

    const stellaDataDir = await makeTempDir();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/azure-openai-responses")) {
        return new Response(JSON.stringify(azureOpenAIResponsesCatalog), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    try {
      const runtime = new ModelRuntime();
      await runtime.initialize({ stellaDataDir, allowNetwork: true });

      expect(runtime.getSnapshot().catalogError).toBeUndefined();
      expect(runtime.getModels("azure-openai-responses")).toHaveLength(47);
      expect(
        runtime.getModel("azure-openai-responses", "gpt-5.6-luna"),
      ).toMatchObject({
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        baseUrl: "",
      });
      expect(
        runtime.getModel("azure-openai-responses", "codex-mini-latest"),
      ).toBeDefined();

      const restored = new ModelRuntime();
      await restored.initialize({ stellaDataDir, allowNetwork: false });
      expect(
        restored.getModel("azure-openai-responses", "gpt-5.6-luna"),
      ).toBeDefined();
      expect(
        restored.getModel("azure-openai-responses", "codex-mini-latest"),
      ).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("drops a malformed cached catalog entry before it can override a builtin id", async () => {
    const stellaDataDir = await makeTempDir();
    const builtin = new ModelRuntime().getModels("xai")[0];
    if (!builtin) throw new Error("Expected an xAI builtin model");
    await writeFile(
      path.join(stellaDataDir, "models-store.json"),
      JSON.stringify({
        xai: {
          models: [
            validRemoteCatalogModel({
              id: builtin.id,
              name: "Malformed Cached Override",
              cost: { input: "NaN", output: 2, cacheRead: 0, cacheWrite: 0 },
            }),
          ],
          checkedAt: Date.now(),
        },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runtime = new ModelRuntime();
      await runtime.initialize({ stellaDataDir, allowNetwork: false });

      expect(runtime.getModel("xai", builtin.id)).toEqual(builtin);
      expect(warn).toHaveBeenCalledWith(
        "[stella:model-runtime] Dropping invalid remote catalog entry",
        expect.objectContaining({
          providerId: "xai",
          source: "cache",
          modelId: builtin.id,
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("repairs a recent malformed cached catalog during online initialization", async () => {
    const stellaDataDir = await makeTempDir();
    await writeFile(
      path.join(stellaDataDir, "models-store.json"),
      JSON.stringify({
        xai: {
          models: [
            validRemoteCatalogModel({
              id: "grok-malformed-cache",
              cost: { input: "NaN", output: 2, cacheRead: 0, cacheWrite: 0 },
            }),
          ],
          checkedAt: Date.now(),
        },
      }),
    );
    const originalFetch = globalThis.fetch;
    let xaiRequests = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/xai")) {
        xaiRequests += 1;
        return new Response(
          JSON.stringify({
            models: [
              validRemoteCatalogModel({
                id: "grok-repaired-cache",
                name: "Grok Repaired Cache",
              }),
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const runtime = new ModelRuntime();
      await runtime.initialize({ stellaDataDir, allowNetwork: true });

      expect(xaiRequests).toBe(1);
      expect(runtime.getModel("xai", "grok-malformed-cache")).toBeUndefined();
      expect(runtime.getModel("xai", "grok-repaired-cache")?.name).toBe(
        "Grok Repaired Cache",
      );
      const repairedStore = JSON.parse(
        await readFile(path.join(stellaDataDir, "models-store.json"), "utf8"),
      ) as { xai?: { models?: Array<{ id?: string }> } };
      expect(repairedStore.xai?.models).toEqual([
        expect.objectContaining({ id: "grok-repaired-cache" }),
      ]);
      expect(warn).toHaveBeenCalledWith(
        "[stella:model-runtime] Dropping invalid remote catalog entry",
        expect.objectContaining({ providerId: "xai", source: "cache" }),
      );
    } finally {
      warn.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("does not erase a malformed persisted catalog when its repair response is all invalid", async () => {
    const stellaDataDir = await makeTempDir();
    const storePath = path.join(stellaDataDir, "models-store.json");
    const malformedCachedModel = validRemoteCatalogModel({
      id: "grok-malformed-last-good",
      cost: { input: "NaN", output: 2, cacheRead: 0, cacheWrite: 0 },
    });
    await writeFile(
      storePath,
      JSON.stringify({
        xai: {
          models: [malformedCachedModel],
          checkedAt: Date.now(),
        },
      }),
    );
    const storedBefore = JSON.parse(await readFile(storePath, "utf8")) as {
      xai?: unknown;
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/xai")) {
        return new Response(
          JSON.stringify({
            models: [
              validRemoteCatalogModel({
                id: "grok-invalid-repair",
                cost: {
                  input: "NaN",
                  output: 2,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
              }),
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const runtime = new ModelRuntime();
      await runtime.initialize({ stellaDataDir, allowNetwork: true });

      expect(runtime.getSnapshot().catalogError).toMatch(
        /xai: Invalid model catalog for xai/u,
      );
      expect(runtime.getModel("xai", "grok-malformed-last-good")).toBeUndefined();
      expect(runtime.getModel("xai", "grok-invalid-repair")).toBeUndefined();
      const storedAfter = JSON.parse(await readFile(storePath, "utf8")) as {
        xai?: unknown;
      };
      expect(storedAfter.xai).toEqual(storedBefore.xai);

      const restored = new ModelRuntime();
      await restored.initialize({ stellaDataDir, allowNetwork: false });
      expect(
        restored.getModel("xai", "grok-malformed-last-good"),
      ).toBeUndefined();
    } finally {
      warn.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("drops and logs remote catalog entries missing api", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runtime = await refreshXaiCatalog(() => [
        validRemoteCatalogModel({ id: "missing-api", api: undefined }),
      ]);

      expect(runtime.getModel("xai", "missing-api")).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "[stella:model-runtime] Dropping invalid remote catalog entry",
        expect.objectContaining({ providerId: "xai", modelId: "missing-api" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("drops and logs remote catalog entries missing cost", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runtime = await refreshXaiCatalog(() => [
        validRemoteCatalogModel({ id: "missing-cost", cost: undefined }),
      ]);

      expect(runtime.getModel("xai", "missing-cost")).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "[stella:model-runtime] Dropping invalid remote catalog entry",
        expect.objectContaining({ providerId: "xai", modelId: "missing-cost" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects non-finite and unsupported negative remote catalog costs", () => {
    for (const input of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const entry = validRemoteCatalogModel({
        cost: { input, output: 2, cacheRead: 0, cacheWrite: 0 },
      });
      expect(isRemoteCatalogModel(entry)).toBe(false);
      expect(getRemoteCatalogModelValidationErrors(entry)).toEqual([
        expect.stringMatching(/^\/cost\/input: Expected (?:number|union)/u),
      ]);
    }
  });

  it("accepts the OpenRouter auto-routing unknown-price sentinel fixture", async () => {
    const auto = openRouterAutoCatalog["openrouter/auto"];
    expect(isRemoteCatalogModel(auto, "openrouter")).toBe(true);
    expect(isRemoteCatalogModel(auto)).toBe(false);
    expect(isRemoteCatalogModel(auto, "xai")).toBe(false);
    expect(
      isRemoteCatalogModel(
        { ...auto, id: "openrouter/not-auto" },
        "openrouter",
      ),
    ).toBe(false);
    expect(
      isRemoteCatalogModel(
        {
          ...auto,
          cost: { ...auto.cost, cacheRead: -1_000_000 },
        },
        "openrouter",
      ),
    ).toBe(false);

    const stellaDataDir = await makeTempDir();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/openrouter")) {
        return new Response(JSON.stringify(openRouterAutoCatalog), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      const runtime = new ModelRuntime();
      await runtime.initialize({ stellaDataDir, allowNetwork: true });
      const stored = JSON.parse(
        await readFile(path.join(stellaDataDir, "models-store.json"), "utf8"),
      ) as { openrouter?: { models?: Array<{ id?: string }> } };

      expect(
        stored.openrouter?.models?.some(
          (model) => model.id === "openrouter/auto",
        ),
      ).toBe(true);
      expect(runtime.getModel("openrouter", "openrouter/auto")?.cost).toEqual(
        auto.cost,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a spoofed OpenRouter sentinel before it can override an xAI builtin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let builtinBefore:
        | ReturnType<ModelRuntime["getModels"]>[number]
        | undefined;
      const runtime = await refreshXaiCatalog((catalogRuntime) => {
        builtinBefore = catalogRuntime.getModels("xai")[0];
        if (!builtinBefore) throw new Error("Expected an xAI builtin model");
        return [
          validRemoteCatalogModel({
            id: builtinBefore.id,
            name: "Spoofed OpenRouter Sentinel Override",
            provider: "openrouter",
            cost: {
              input: -1_000_000,
              output: -1_000_000,
              cacheRead: 0,
              cacheWrite: 0,
            },
          }),
        ];
      });

      expect(runtime.getModel("xai", builtinBefore?.id ?? "")).toEqual(
        builtinBefore,
      );
      expect(warn).toHaveBeenCalledWith(
        "[stella:model-runtime] Dropping invalid remote catalog entry",
        expect.objectContaining({
          providerId: "xai",
          modelId: builtinBefore?.id,
          errors: expect.arrayContaining([
            expect.stringMatching(/^\/cost\/input:/u),
            expect.stringMatching(/^\/cost\/output:/u),
          ]),
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not accept an empty base URL for a non-Azure builtin collision", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let builtinBefore:
        | ReturnType<ModelRuntime["getModels"]>[number]
        | undefined;
      const runtime = await refreshXaiCatalog((catalogRuntime) => {
        builtinBefore = catalogRuntime.getModels("xai")[0];
        if (!builtinBefore) throw new Error("Expected an xAI builtin model");
        return [
          validRemoteCatalogModel({
            id: builtinBefore.id,
            name: "Malformed Empty URL Override",
            baseUrl: "",
          }),
        ];
      });

      expect(runtime.getModel("xai", builtinBefore?.id ?? "")).toEqual(
        builtinBefore,
      );
      expect(warn).toHaveBeenCalledWith(
        "[stella:model-runtime] Dropping invalid remote catalog entry",
        expect.objectContaining({
          providerId: "xai",
          modelId: builtinBefore?.id,
          errors: expect.arrayContaining([
            "/baseUrl: Expected string length greater or equal to 1",
          ]),
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not let a malformed remote catalog entry override a builtin id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let builtinBefore:
        | ReturnType<ModelRuntime["getModels"]>[number]
        | undefined;
      const runtime = await refreshXaiCatalog((catalogRuntime) => {
        builtinBefore = catalogRuntime.getModels("xai")[0];
        if (!builtinBefore) throw new Error("Expected an xAI builtin model");
        return [
          validRemoteCatalogModel({
            id: builtinBefore.id,
            name: "Malformed Override",
            cost: { input: "NaN", output: 2, cacheRead: 0, cacheWrite: 0 },
          }),
        ];
      });

      expect(runtime.getModel("xai", builtinBefore?.id ?? "")).toEqual(
        builtinBefore,
      );
      expect(warn).toHaveBeenCalledWith(
        "[stella:model-runtime] Dropping invalid remote catalog entry",
        expect.objectContaining({
          providerId: "xai",
          modelId: builtinBefore?.id,
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts a fully valid remote catalog entry", async () => {
    const runtime = await refreshXaiCatalog(() => [validRemoteCatalogModel()]);

    expect(runtime.getModel("xai", "grok-remote-valid")).toMatchObject({
      id: "grok-remote-valid",
      name: "Grok Remote Valid",
      provider: "xai",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("preserves the last-good catalog and cache when a non-empty refresh is all invalid", async () => {
    const stellaDataDir = await makeTempDir();
    const storePath = path.join(stellaDataDir, "models-store.json");
    const runtime = new ModelRuntime();
    const originalFetch = globalThis.fetch;
    let serveInvalidCatalog = false;
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/xai")) {
        return new Response(
          JSON.stringify({
            models: serveInvalidCatalog
              ? [
                  validRemoteCatalogModel({
                    id: "grok-invalid-refresh",
                    cost: {
                      input: "NaN",
                      output: 2,
                      cacheRead: 0,
                      cacheWrite: 0,
                    },
                  }),
                ]
              : [
                  validRemoteCatalogModel({
                    id: "grok-last-good-invalid-refresh",
                    name: "Grok Last Good Invalid Refresh",
                  }),
                ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    try {
      await runtime.initialize({ stellaDataDir, allowNetwork: true });
      const storedBefore = JSON.parse(await readFile(storePath, "utf8")) as {
        xai?: unknown;
      };
      expect(
        runtime.getModel("xai", "grok-last-good-invalid-refresh"),
      ).toBeDefined();

      serveInvalidCatalog = true;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const snapshot = await runtime.getSnapshotForListing({
          forceRefresh: true,
        });

        expect(snapshot.catalogError).toMatch(
          /xai: Invalid model catalog for xai: non-empty payload contained 1 invalid entry and no valid entries/u,
        );
        expect(
          runtime.getModel("xai", "grok-last-good-invalid-refresh"),
        ).toBeDefined();
        expect(runtime.getModel("xai", "grok-invalid-refresh")).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          "[stella:model-runtime] Dropping invalid remote catalog entry",
          expect.objectContaining({ providerId: "xai", source: "network" }),
        );
      } finally {
        warn.mockRestore();
      }

      const storedAfter = JSON.parse(await readFile(storePath, "utf8")) as {
        xai?: unknown;
      };
      expect(storedAfter.xai).toEqual(storedBefore.xai);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forces a fresh pi.dev request at explicit refresh boundaries", async () => {
    const stellaDataDir = await makeTempDir();
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });
    const originalFetch = globalThis.fetch;
    let xaiRequests = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/xai")) xaiRequests += 1;
      return new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await runtime.getSnapshotForListing({ forceRefresh: true });
      await runtime.getSnapshotForListing({ forceRefresh: true });
      expect(xaiRequests).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runs a queued forced refresh after a background refresh rejects", async () => {
    const stellaDataDir = await makeTempDir();
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });
    const originalFetch = globalThis.fetch;
    let releaseBackground!: () => void;
    const backgroundGate = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    let backgroundAttempt = true;
    let xaiRequests = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/xai")) xaiRequests += 1;
      if (backgroundAttempt) {
        await backgroundGate;
        throw new Error("background outage");
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    try {
      await runtime.getSnapshotForListing();
      const forced = runtime.getSnapshotForListing({ forceRefresh: true });
      backgroundAttempt = false;
      releaseBackground();

      await expect(forced).resolves.toMatchObject({
        catalogError: undefined,
      });
      expect(xaiRequests).toBe(2);

      await expect(
        runtime.getSnapshotForListing({ forceRefresh: true }),
      ).resolves.toBeDefined();
      expect(xaiRequests).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves the last-good catalog and rejects an all-failed forced refresh", async () => {
    const stellaDataDir = await makeTempDir();
    const runtime = new ModelRuntime();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/xai")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                id: "grok-last-good",
                name: "Grok Last Good",
                provider: "xai",
                api: "openai-responses",
                baseUrl: "https://api.x.ai/v1",
                reasoning: true,
                input: ["text"],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_000,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    try {
      await runtime.initialize({ stellaDataDir, allowNetwork: true });
      const refreshedAt = runtime.getSnapshot().refreshedAt;
      expect(runtime.getModel("xai", "grok-last-good")).toBeDefined();

      globalThis.fetch = (async () => {
        throw new Error("network offline");
      }) as typeof fetch;

      await expect(
        runtime.getSnapshotForListing({ forceRefresh: true }),
      ).rejects.toThrow(/Model catalog refresh failed.*network offline/u);
      const failedSnapshot = runtime.getSnapshot();
      expect(failedSnapshot.refreshedAt).toBe(refreshedAt);
      expect(failedSnapshot.catalogError).toMatch(/network offline/u);
      expect(runtime.getModel("xai", "grok-last-good")).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("publishes partial refresh failures while retaining successful results", async () => {
    const stellaDataDir = await makeTempDir();
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/xai")) {
        throw new Error("xAI catalog unavailable");
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    try {
      const snapshot = await runtime.getSnapshotForListing({
        forceRefresh: true,
      });
      expect(snapshot.refreshedAt).not.toBeNull();
      expect(snapshot.catalogError).toMatch(
        /xai: xAI catalog unavailable/u,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns the current snapshot without awaiting background catalog refresh", async () => {
    const stellaDataDir = await makeTempDir();
    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });
    const originalFetch = globalThis.fetch;
    let releaseFetch!: (response: Response) => void;
    const fetchGate = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    let blockFetches = true;
    let xaiRequests = 0;
    globalThis.fetch = ((input) => {
      if (String(input).endsWith("/xai")) xaiRequests += 1;
      return blockFetches
        ? fetchGate
        : Promise.resolve(new Response("", { status: 404 }));
    }) as typeof fetch;
    try {
      const onCatalogChanged = vi.fn();
      const unsubscribe = runtime.onCatalogChanged(onCatalogChanged);
      const listing = runtime.getSnapshotForListing();
      const outcome = await Promise.race([
        listing.then(() => "listed" as const),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 100),
        ),
      ]);
      const forcedListing = runtime.getSnapshotForListing({
        forceRefresh: true,
      });
      blockFetches = false;
      releaseFetch(new Response("", { status: 404 }));
      expect(outcome).toBe("listed");
      await forcedListing;
      expect(xaiRequests).toBe(2);
      expect(onCatalogChanged).toHaveBeenCalled();
      expect(
        onCatalogChanged.mock.calls.some(
          ([snapshot]) => snapshot.refreshedAt !== null,
        ),
      ).toBe(true);
      unsubscribe();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
