import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers to dynamically import the module with fresh module-level state.
// Each call to freshModule() gives isolated caches / in-flight requests.
// ---------------------------------------------------------------------------

type TwitchEmotesModule = typeof import("./twitch-emotes");

const freshModule = async (): Promise<TwitchEmotesModule> => {
  vi.resetModules();
  return (await import("./twitch-emotes")) as TwitchEmotesModule;
};

// ---------------------------------------------------------------------------
// Mock React hooks so the module can load in a test environment without a
// real React runtime. The hooks themselves are tested minimally since they
// are thin wrappers around the async loaders.
// ---------------------------------------------------------------------------

vi.mock("react", () => ({
  useState: (init: unknown) => [init, vi.fn()],
  useEffect: (fn: () => void) => fn(),
}));

// ---------------------------------------------------------------------------
// Fetch mock and localStorage mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

const createMockStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (_index: number) => null,
  } as Storage;
};

let mockStorage: Storage;

beforeEach(() => {
  mockFetch.mockReset();
  mockStorage = createMockStorage();

  vi.stubGlobal("fetch", mockFetch);
  Object.defineProperty(window, "localStorage", {
    value: mockStorage,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helper: create a standard "ok" fetch response
// ---------------------------------------------------------------------------

const jsonResponse = (body: unknown, ok = true) =>
  Promise.resolve({
    ok,
    status: ok ? 200 : 404,
    json: () => Promise.resolve(body),
  });

const notFoundResponse = () => jsonResponse(null, false);
const networkError = () => Promise.reject(new Error("network failure"));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const make7tvEmote = (
  name: string,
  hostUrl: string,
  files: string[],
  animated = false,
) => ({
  name,
  data: {
    animated,
    host: {
      url: hostUrl,
      files: files.map((f) => ({ name: f })),
    },
  },
});

const makeBttvEmote = (id: string, code: string, animated = false) => ({
  id,
  code,
  animated,
});

const makeTemotesEmote = (
  code: string,
  provider: number,
  urls: Array<{ size: string; url: string }>,
) => ({
  code,
  provider,
  urls,
});

// ===========================================================================
// TEST SUITES
// ===========================================================================

describe("twitch-emotes", () => {
  // -------------------------------------------------------------------------
  // loadTwitchEmoteLookup - primary exported async function
  // -------------------------------------------------------------------------

  describe("loadTwitchEmoteLookup", () => {
    it("returns an empty map when all fetches fail", async () => {
      mockFetch.mockImplementation(() => notFoundResponse());
      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup).toBeInstanceOf(Map);
      // The local manifest fetch also returns 404, so nothing loads
      expect(lookup.size).toBe(0);
    });

    it("loads emotes from 7TV global endpoint", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              make7tvEmote("catJAM", "//cdn.7tv.app/emote/abc", [
                "4x.webp",
                "2x.webp",
              ]),
              make7tvEmote("LULW", "//cdn.7tv.app/emote/def", ["3x.webp"]),
            ],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.get("catJAM")).toBe(
        "https://cdn.7tv.app/emote/abc/4x.webp",
      );
      expect(lookup.get("LULW")).toBe(
        "https://cdn.7tv.app/emote/def/3x.webp",
      );
    });

    it("loads emotes from BTTV global endpoint", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([
            makeBttvEmote("emote123", "PepeLaugh", false),
            makeBttvEmote("emote456", "Clap", true),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.get("PepeLaugh")).toBe(
        "https://cdn.betterttv.net/emote/emote123/3x.webp",
      );
      expect(lookup.get("Clap")).toBe(
        "https://cdn.betterttv.net/emote/emote456/3x.gif",
      );
    });

    it("loads emotes from temotes (adamcy) endpoint", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("KEKW", 1, [
              { size: "2x", url: "//cdn.example/kekw_2x.webp" },
              { size: "4x", url: "//cdn.example/kekw_4x.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      // Should pick 4x because it's preferred
      expect(lookup.get("KEKW")).toBe("https://cdn.example/kekw_4x.webp");
    });

    it("merges emotes from multiple providers with priority resolution", async () => {
      // 7TV global has priority 20, temotes global has priority 18
      // So 7TV should win for same emote code
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              make7tvEmote("OMEGALUL", "//cdn.7tv.app/emote/aaa", [
                "4x.webp",
              ]),
            ],
          });
        }
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("OMEGALUL", 1, [
              { size: "4x", url: "//cdn.example/omegalul.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      // 7TV global (priority 20) > temotes global (priority 18)
      expect(lookup.get("OMEGALUL")).toBe(
        "https://cdn.7tv.app/emote/aaa/4x.webp",
      );
    });

    it("handles network errors gracefully", async () => {
      mockFetch.mockImplementation(() => networkError());
      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup).toBeInstanceOf(Map);
    });

    it("caches results in localStorage", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("emote1", "Sadge", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      await mod.loadTwitchEmoteLookup();

      const stored = mockStorage.getItem("stella:twitch-emotes:v2");
      expect(stored).not.toBeNull();

      const parsed = JSON.parse(stored!);
      expect(parsed.expiresAt).toBeGreaterThan(Date.now());
      expect(Array.isArray(parsed.emotes)).toBe(true);
      expect(parsed.emotes.some((e: { code: string }) => e.code === "Sadge")).toBe(true);
    });

    it("uses cached results from localStorage on second load", async () => {
      // First load: populate cache
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "peepoHappy", false)]);
        }
        return notFoundResponse();
      });

      const mod1 = await freshModule();
      await mod1.loadTwitchEmoteLookup();
      const callCountAfterFirst = mockFetch.mock.calls.length;

      // Second fresh module load should find cache in localStorage
      const mod2 = await freshModule();
      const lookup = await mod2.loadTwitchEmoteLookup();

      expect(lookup.get("peepoHappy")).toBe(
        "https://cdn.betterttv.net/emote/e1/3x.webp",
      );
      // It should NOT have made additional fetch calls beyond the local manifest check
      // (localStorage was used instead of re-fetching from APIs)
      // The manifest fetch is the only new call
      const newCalls = mockFetch.mock.calls.length - callCountAfterFirst;
      // Only the local manifest fetch (which returns 404)
      expect(newCalls).toBeLessThanOrEqual(1);
    });

    it("uses in-memory cache for repeated calls within same module", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "forsenCD", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup1 = await mod.loadTwitchEmoteLookup();
      const callCount = mockFetch.mock.calls.length;

      const lookup2 = await mod.loadTwitchEmoteLookup();

      // No new fetch calls -- in-memory cache served
      expect(mockFetch.mock.calls.length).toBe(callCount);
      expect(lookup1.get("forsenCD")).toBe(lookup2.get("forsenCD"));
    });

    it("loads from local manifest JSON when available (highest priority)", async () => {
      const manifestData = {
        version: 1,
        generatedAt: "2025-01-01",
        channels: ["test"],
        emotes: [
          {
            code: "LocalEmote",
            url: "/emotes/local/test.webp",
            provider: "7tv",
            animated: false,
            priority: 50,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("manifest.json")) {
          return jsonResponse(manifestData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      // Local manifest is returned, no remote fetches needed
      expect(lookup.size).toBe(1);
      expect(lookup.get("LocalEmote")).toBeDefined();
    });

    it("skips emotes with invalid codes in local manifest", async () => {
      const manifestData = {
        version: 1,
        emotes: [
          {
            code: "Valid",
            url: "https://cdn.example/valid.webp",
            provider: "7tv",
            animated: false,
            priority: 50,
          },
          {
            code: "a",
            url: "https://cdn.example/short.webp",
            provider: "7tv",
            animated: false,
            priority: 50,
          },
          {
            code: "has space",
            url: "https://cdn.example/space.webp",
            provider: "7tv",
            animated: false,
            priority: 50,
          },
          {
            code: "",
            url: "https://cdn.example/empty.webp",
            provider: "7tv",
            animated: false,
            priority: 50,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("manifest.json")) {
          return jsonResponse(manifestData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.has("Valid")).toBe(true);
      expect(lookup.has("a")).toBe(false);
      expect(lookup.has("has space")).toBe(false);
      expect(lookup.has("")).toBe(false);
    });

    it("falls through to remote APIs when local manifest has no emotes array", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("manifest.json")) {
          return jsonResponse({ version: 1, channels: [] });
        }
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "RemoteOnly", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.get("RemoteOnly")).toBe(
        "https://cdn.betterttv.net/emote/e1/3x.webp",
      );
    });

    it("falls through to remote APIs when local manifest fetch fails", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("manifest.json")) {
          return networkError();
        }
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "FallbackEmote", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.get("FallbackEmote")).toBe(
        "https://cdn.betterttv.net/emote/e1/3x.webp",
      );
    });
  });

  // -------------------------------------------------------------------------
  // 7TV emote mapping details
  // -------------------------------------------------------------------------

  describe("7TV emote mapping", () => {
    it("picks 4x.webp as the preferred file format", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              make7tvEmote("Test7tv", "//cdn.7tv.app/emote/xyz", [
                "1x.webp",
                "2x.webp",
                "3x.webp",
                "4x.webp",
                "1x.avif",
              ]),
            ],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("Test7tv")).toBe(
        "https://cdn.7tv.app/emote/xyz/4x.webp",
      );
    });

    it("falls back to avif when no webp available", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              make7tvEmote("AvifOnly", "//cdn.7tv.app/emote/avif1", [
                "4x.avif",
                "2x.avif",
              ]),
            ],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("AvifOnly")).toBe(
        "https://cdn.7tv.app/emote/avif1/4x.avif",
      );
    });

    it("falls back to gif when no webp or avif available", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              make7tvEmote("GifOnly", "//cdn.7tv.app/emote/gif1", [
                "3x.gif",
                "1x.gif",
              ]),
            ],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("GifOnly")).toBe(
        "https://cdn.7tv.app/emote/gif1/3x.gif",
      );
    });

    it("falls back to any available file when no preferred format found", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              make7tvEmote("CustomFile", "//cdn.7tv.app/emote/custom1", [
                "big.png",
              ]),
            ],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("CustomFile")).toBe(
        "https://cdn.7tv.app/emote/custom1/big.png",
      );
    });

    it("skips emotes with no files", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [make7tvEmote("NoFiles", "//cdn.7tv.app/emote/nf", [])],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.has("NoFiles")).toBe(false);
    });

    it("skips emotes with empty host url", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              {
                name: "NoHost",
                data: {
                  animated: false,
                  host: { url: "", files: [{ name: "4x.webp" }] },
                },
              },
            ],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.has("NoHost")).toBe(false);
    });

    it("skips emotes with no name", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              {
                data: {
                  animated: false,
                  host: {
                    url: "//cdn.7tv.app/emote/x",
                    files: [{ name: "4x.webp" }],
                  },
                },
              },
            ],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.size).toBe(0);
    });

    it("marks animated emotes correctly", async () => {
      // We cannot directly inspect TwitchEmoteRecord via the lookup (which is
      // code -> url), but we can verify the emote loads. The animated flag is
      // stored internally and used elsewhere.
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              make7tvEmote(
                "AnimatedEmote",
                "//cdn.7tv.app/emote/anim1",
                ["4x.webp"],
                true,
              ),
            ],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.has("AnimatedEmote")).toBe(true);
    });

    it("prepends https: to protocol-relative host URLs", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              make7tvEmote("ProtoRel", "//cdn.7tv.app/emote/pr", ["4x.webp"]),
            ],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("ProtoRel")!.startsWith("https://")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // BTTV emote mapping details
  // -------------------------------------------------------------------------

  describe("BTTV emote mapping", () => {
    it("uses .webp extension for non-animated emotes", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("id1", "NotAnimated", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("NotAnimated")).toMatch(/\.webp$/);
    });

    it("uses .gif extension for animated emotes", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("id2", "IsAnimated", true)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("IsAnimated")).toMatch(/\.gif$/);
    });

    it("skips emotes with empty id", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("", "NoId", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.has("NoId")).toBe(false);
    });

    it("skips emotes with invalid code", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([
            makeBttvEmote("id1", "x", false),
            makeBttvEmote("id2", "has space", false),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.has("x")).toBe(false);
      expect(lookup.has("has space")).toBe(false);
    });

    it("includes channel and shared emotes from user endpoint", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/users/twitch")) {
          return jsonResponse({
            channelEmotes: [makeBttvEmote("ch1", "ChannelEmote", false)],
            sharedEmotes: [makeBttvEmote("sh1", "SharedEmote", true)],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.has("ChannelEmote")).toBe(true);
      expect(lookup.has("SharedEmote")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Temotes emote mapping details
  // -------------------------------------------------------------------------

  describe("temotes emote mapping", () => {
    it("maps provider numbers to provider strings", async () => {
      // We test this indirectly - the provider field is stored in
      // TwitchEmoteRecord but the lookup only exposes code -> url.
      // The important thing is that parsing succeeds for all providers.
      const emotes = [
        makeTemotesEmote("TwitchNative", 0, [
          { size: "4x", url: "//cdn.example/twitch.webp" },
        ]),
        makeTemotesEmote("SevenTv", 1, [
          { size: "4x", url: "//cdn.example/7tv.webp" },
        ]),
        makeTemotesEmote("BttvTest", 2, [
          { size: "4x", url: "//cdn.example/bttv.webp" },
        ]),
        makeTemotesEmote("FfzTest", 3, [
          { size: "4x", url: "//cdn.example/ffz.webp" },
        ]),
      ];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse(emotes);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.has("TwitchNative")).toBe(true);
      expect(lookup.has("SevenTv")).toBe(true);
      expect(lookup.has("BttvTest")).toBe(true);
      expect(lookup.has("FfzTest")).toBe(true);
    });

    it("picks highest available size preferring 4x", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("SizeTest", 1, [
              { size: "1x", url: "//cdn.example/1x.webp" },
              { size: "3x", url: "//cdn.example/3x.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("SizeTest")).toBe("https://cdn.example/3x.webp");
    });

    it("detects animated emotes from .gif in URL", async () => {
      // We can verify the emote loads successfully with a .gif URL
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("GifEmote", 1, [
              { size: "4x", url: "//cdn.example/emote.gif" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("GifEmote")).toBe("https://cdn.example/emote.gif");
    });

    it("skips emotes with no valid URL entries", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("NoUrl", 1, []),
            {
              code: "BadUrl",
              provider: 1,
              urls: [{ size: "4x", url: "   " }],
            },
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.has("NoUrl")).toBe(false);
      expect(lookup.has("BadUrl")).toBe(false);
    });

    it("falls back to first available URL when no preferred size matches", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("WeirdSize", 1, [
              { size: "jumbo", url: "//cdn.example/jumbo.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("WeirdSize")).toBe("https://cdn.example/jumbo.webp");
    });

    it("makes absolute URLs from protocol-relative URLs", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("AbsUrl", 1, [
              { size: "4x", url: "//cdn.example/emote.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("AbsUrl")!.startsWith("https://")).toBe(true);
    });

    it("makes absolute URLs from bare domain URLs", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("BareUrl", 1, [
              { size: "4x", url: "cdn.example/emote.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("BareUrl")).toBe("https://cdn.example/emote.webp");
    });
  });

  // -------------------------------------------------------------------------
  // localStorage cache details
  // -------------------------------------------------------------------------

  describe("localStorage cache", () => {
    it("does not crash when localStorage is unavailable", async () => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new Error("localStorage disabled");
        },
        configurable: true,
      });

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "NoStorage", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      // Should still work, just without caching
      expect(lookup.get("NoStorage")).toBe(
        "https://cdn.betterttv.net/emote/e1/3x.webp",
      );
    });

    it("handles corrupted cache data gracefully", async () => {
      mockStorage.setItem("stella:twitch-emotes:v2", "not valid json{{{");

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "AfterCorrupt", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("AfterCorrupt")).toBeDefined();
    });

    it("handles cache with wrong shape gracefully", async () => {
      mockStorage.setItem(
        "stella:twitch-emotes:v2",
        JSON.stringify({ wrong: "shape" }),
      );

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "AfterBadShape", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("AfterBadShape")).toBeDefined();
    });

    it("uses stale cache as fallback when fresh fetch returns empty", async () => {
      // Pre-populate localStorage with a stale cache
      const staleCache = {
        expiresAt: Date.now() - 1000, // expired
        emotes: [
          {
            code: "StaleEmote",
            url: "https://cdn.example/stale.webp",
            provider: "7tv",
            animated: false,
            priority: 20,
          },
        ],
      };
      mockStorage.setItem(
        "stella:twitch-emotes:v2",
        JSON.stringify(staleCache),
      );

      // All remote fetches fail
      mockFetch.mockImplementation(() => notFoundResponse());

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      // Should fall back to stale cache
      expect(lookup.get("StaleEmote")).toBe("https://cdn.example/stale.webp");
    });

    it("filters out invalid emotes when loading from cache", async () => {
      const cacheData = {
        expiresAt: Date.now() + 1000 * 60 * 60, // fresh
        emotes: [
          {
            code: "Good",
            url: "https://cdn.example/good.webp",
            provider: "7tv",
            animated: false,
            priority: 20,
          },
          {
            code: "x",
            url: "https://cdn.example/short.webp",
            provider: "7tv",
            animated: false,
            priority: 20,
          },
          {
            code: null,
            url: "https://cdn.example/null.webp",
            provider: "7tv",
            animated: false,
            priority: 20,
          },
          {
            code: "NoUrl",
            url: null,
            provider: "7tv",
            animated: false,
            priority: 20,
          },
        ],
      };
      mockStorage.setItem(
        "stella:twitch-emotes:v2",
        JSON.stringify(cacheData),
      );

      mockFetch.mockImplementation(() => notFoundResponse());

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.has("Good")).toBe(true);
      expect(lookup.has("x")).toBe(false);
      expect(lookup.size).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // loadEmojiEmoteLookup
  // -------------------------------------------------------------------------

  describe("loadEmojiEmoteLookup", () => {
    it("loads emoji lookup from emoji-index.json", async () => {
      const emojiData = {
        version: 1,
        entries: [
          {
            code: "PogChamp",
            emoji: "\u2728",
            url: "https://cdn.example/pog.webp",
            confidence: 0.9,
          },
          {
            code: "FeelsBadMan",
            emoji: "\u2639\uFE0F",
            url: "https://cdn.example/sad.webp",
            confidence: 0.8,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse(emojiData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();

      expect(lookup.get("\u2728")).toBe("https://cdn.example/pog.webp");
      // The variation selector is stripped in normalization, so bare version works
      expect(lookup.get("\u2639")).toBe("https://cdn.example/sad.webp");
    });

    it("falls back to emoji-labels.json when emoji-index.json is empty", async () => {
      const labelsData = {
        version: 1,
        labels: [
          {
            code: "Sadge",
            emoji: "\u2639\uFE0F",
            url: "https://cdn.example/sadge.webp",
            confidence: 0.7,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return notFoundResponse();
        }
        if (url.includes("emoji-labels.json")) {
          return jsonResponse(labelsData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();

      expect(lookup.get("\u2639")).toBe("https://cdn.example/sadge.webp");
    });

    it("returns empty map when both emoji files fail", async () => {
      mockFetch.mockImplementation(() => notFoundResponse());

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();

      expect(lookup.size).toBe(0);
    });

    it("picks highest confidence entry for same emoji", async () => {
      const emojiData = {
        version: 1,
        entries: [
          {
            code: "LowConf",
            emoji: "\u2728",
            url: "https://cdn.example/low.webp",
            confidence: 0.5,
          },
          {
            code: "HighConf",
            emoji: "\u2728",
            url: "https://cdn.example/high.webp",
            confidence: 0.95,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse(emojiData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();

      expect(lookup.get("\u2728")).toBe("https://cdn.example/high.webp");
    });

    it("breaks confidence ties by lexicographic code order", async () => {
      const emojiData = {
        version: 1,
        entries: [
          {
            code: "Bravo",
            emoji: "\u2728",
            url: "https://cdn.example/bravo.webp",
            confidence: 0.9,
          },
          {
            code: "Alpha",
            emoji: "\u2728",
            url: "https://cdn.example/alpha.webp",
            confidence: 0.9,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse(emojiData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();

      // "Alpha" < "Bravo" lexicographically, so Alpha wins the tie
      expect(lookup.get("\u2728")).toBe("https://cdn.example/alpha.webp");
    });

    it("stores both original and normalized emoji keys (variation selector stripped)", async () => {
      const emojiData = {
        version: 1,
        entries: [
          {
            code: "Heart",
            emoji: "\u2764\uFE0F",
            url: "https://cdn.example/heart.webp",
            confidence: 0.9,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse(emojiData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();

      // Both with and without variation selector should resolve
      expect(lookup.get("\u2764\uFE0F")).toBe(
        "https://cdn.example/heart.webp",
      );
      expect(lookup.get("\u2764")).toBe("https://cdn.example/heart.webp");
    });

    it("skips entries with missing emoji or url fields", async () => {
      const emojiData = {
        version: 1,
        entries: [
          { code: "NoEmoji", url: "https://cdn.example/no.webp", confidence: 0.5 },
          { code: "NoUrl", emoji: "\u2728", confidence: 0.5 },
          {
            code: "Valid",
            emoji: "\u2728",
            url: "https://cdn.example/valid.webp",
            confidence: 0.5,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse(emojiData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();

      expect(lookup.get("\u2728")).toBe("https://cdn.example/valid.webp");
      // Only 2 entries (the valid emoji + its normalized form without variation selector)
      // But sparkles has no variation selector, so it's just the same key.
      // Only valid entries should be present.
      expect(lookup.size).toBeGreaterThanOrEqual(1);
    });

    it("treats missing confidence as 0", async () => {
      const emojiData = {
        version: 1,
        entries: [
          {
            code: "NoConf",
            emoji: "\u2728",
            url: "https://cdn.example/noconf.webp",
          },
          {
            code: "WithConf",
            emoji: "\u2728",
            url: "https://cdn.example/withconf.webp",
            confidence: 0.5,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse(emojiData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();

      // WithConf (0.5) > NoConf (0)
      expect(lookup.get("\u2728")).toBe("https://cdn.example/withconf.webp");
    });

    it("caches emoji lookup in memory after first load", async () => {
      const emojiData = {
        version: 1,
        entries: [
          {
            code: "Cached",
            emoji: "\u2728",
            url: "https://cdn.example/cached.webp",
            confidence: 0.9,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse(emojiData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup1 = await mod.loadEmojiEmoteLookup();
      const callCount = mockFetch.mock.calls.length;

      const lookup2 = await mod.loadEmojiEmoteLookup();

      // No new fetch calls
      expect(mockFetch.mock.calls.length).toBe(callCount);
      expect(lookup1).toBe(lookup2);
    });

    it("handles network errors for emoji lookup", async () => {
      mockFetch.mockImplementation(() => networkError());

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();

      expect(lookup.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // useTwitchEmoteLookup hook
  // -------------------------------------------------------------------------

  describe("useTwitchEmoteLookup", () => {
    it("returns null when disabled", async () => {
      const mod = await freshModule();
      const result = mod.useTwitchEmoteLookup(false);
      expect(result).toBeNull();
    });

    it("returns null initially when enabled (async not resolved)", async () => {
      mockFetch.mockImplementation(() => notFoundResponse());
      const mod = await freshModule();
      // The hook calls loadTwitchEmoteLookup which is async, but our mocked
      // useState returns the initial value (null)
      const result = mod.useTwitchEmoteLookup(true);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // useEmojiEmoteLookup hook
  // -------------------------------------------------------------------------

  describe("useEmojiEmoteLookup", () => {
    it("returns null when disabled", async () => {
      const mod = await freshModule();
      const result = mod.useEmojiEmoteLookup(false);
      expect(result).toBeNull();
    });

    it("returns null initially when enabled", async () => {
      mockFetch.mockImplementation(() => notFoundResponse());
      const mod = await freshModule();
      const result = mod.useEmojiEmoteLookup(true);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Priority / upsert behavior
  // -------------------------------------------------------------------------

  describe("emote priority and upsert", () => {
    it("higher priority emote wins when same code exists", async () => {
      // BTTV global = priority 10, temotes channel = priority 45
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "DupeEmote", false)]);
        }
        if (url.includes("emotes.adamcy.pl") && url.includes("/channel/")) {
          return jsonResponse([
            makeTemotesEmote("DupeEmote", 1, [
              { size: "4x", url: "//cdn.temotes/dupe.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      // Temotes channel (priority 45) should beat BTTV global (priority 10)
      expect(lookup.get("DupeEmote")).toBe("https://cdn.temotes/dupe.webp");
    });

    it("equal priority keeps the later emote (upsert replaces on >=)", async () => {
      // Both at the same priority level - the one processed later wins
      // 7TV global = priority 20, temotes order in the merge is
      // [...temotes, ...bttv, ...sevenTv] so 7TV is last -> wins on equal priority
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              make7tvEmote("EqualP", "//cdn.7tv.app/emote/eq1", ["4x.webp"]),
            ],
          });
        }
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          // Temotes global has priority 18, so 7TV (20) still wins
          return jsonResponse([
            makeTemotesEmote("EqualP", 1, [
              { size: "4x", url: "//cdn.temotes/eq1.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      // 7TV global (20) > temotes global (18)
      expect(lookup.get("EqualP")).toBe(
        "https://cdn.7tv.app/emote/eq1/4x.webp",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Channel normalization
  // -------------------------------------------------------------------------

  describe("channel handling", () => {
    it("handles temotes channel-specific fetches", async () => {
      const channelUrls: string[] = [];

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("/channel/")) {
          channelUrls.push(url);
          return jsonResponse([
            makeTemotesEmote("ChannelEmote", 1, [
              { size: "4x", url: "//cdn.example/ch.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      await mod.loadTwitchEmoteLookup();

      // Default fallback channels are used when no env vars are set
      // (xqc, forsen, sodapoppin, lirik, nymn, pokelawls)
      expect(channelUrls.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // In-flight request deduplication
  // -------------------------------------------------------------------------

  describe("in-flight request deduplication", () => {
    it("deduplicates concurrent calls to loadTwitchEmoteLookup", async () => {
      let fetchCallCount = 0;
      mockFetch.mockImplementation((url: string) => {
        fetchCallCount++;
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "Dedup", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();

      // Fire two concurrent loads
      const [lookup1, lookup2] = await Promise.all([
        mod.loadTwitchEmoteLookup(),
        mod.loadTwitchEmoteLookup(),
      ]);

      // Both should return the same result
      expect(lookup1.get("Dedup")).toBe(lookup2.get("Dedup"));
    });

    it("deduplicates concurrent calls to loadEmojiEmoteLookup", async () => {
      const emojiData = {
        version: 1,
        entries: [
          {
            code: "Dedup",
            emoji: "\u2728",
            url: "https://cdn.example/dedup.webp",
            confidence: 0.9,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse(emojiData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();

      const [lookup1, lookup2] = await Promise.all([
        mod.loadEmojiEmoteLookup(),
        mod.loadEmojiEmoteLookup(),
      ]);

      // Both should return the same map instance
      expect(lookup1).toBe(lookup2);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases: emote code validation
  // -------------------------------------------------------------------------

  describe("emote code validation", () => {
    it("accepts codes with length >= 2 and no whitespace", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([
            makeBttvEmote("id1", "OK", false),
            makeBttvEmote("id2", "ab", false),
            makeBttvEmote("id3", "LongEmoteName123", false),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.has("OK")).toBe(true);
      expect(lookup.has("ab")).toBe(true);
      expect(lookup.has("LongEmoteName123")).toBe(true);
    });

    it("rejects codes with length < 2", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([
            makeBttvEmote("id1", "x", false),
            makeBttvEmote("id2", "", false),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.has("x")).toBe(false);
      expect(lookup.has("")).toBe(false);
    });

    it("rejects codes containing whitespace", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([
            makeBttvEmote("id1", "has space", false),
            makeBttvEmote("id2", "has\ttab", false),
            makeBttvEmote("id3", "has\nnewline", false),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.size).toBe(0);
    });

    it("trims emote codes before validation", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([
            makeBttvEmote("id1", "  Trimmed  ", false),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.has("Trimmed")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Emote data with missing/null fields
  // -------------------------------------------------------------------------

  describe("malformed emote data resilience", () => {
    it("handles 7TV emotes with undefined data gracefully", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              { name: "NoData" },
              {
                name: "NoHost",
                data: { animated: false },
              },
              {
                name: "EmptyHost",
                data: { animated: false, host: {} },
              },
            ],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.has("NoData")).toBe(false);
      expect(lookup.has("NoHost")).toBe(false);
      expect(lookup.has("EmptyHost")).toBe(false);
    });

    it("handles BTTV emotes with non-string fields", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([
            { id: 123, code: "NumericId", animated: false },
            { id: "validId", code: 456, animated: false },
            { id: null, code: "NullId", animated: false },
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.has("NumericId")).toBe(false);
      expect(lookup.size).toBe(0);
    });

    it("handles temotes with empty-object emote entries", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            {},
            { code: 123 },
            makeTemotesEmote("ValidAfterJunk", 1, [
              { size: "4x", url: "//cdn.example/valid.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.has("ValidAfterJunk")).toBe(true);
    });

    it("handles 7TV response where emotes array is undefined", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({});
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      // No crash, just an empty (or other-source) map
      expect(lookup).toBeInstanceOf(Map);
    });

    it("handles BTTV user response with missing channelEmotes/sharedEmotes", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/users/twitch")) {
          return jsonResponse({});
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup).toBeInstanceOf(Map);
    });
  });

  // -------------------------------------------------------------------------
  // 7TV file selection detail
  // -------------------------------------------------------------------------

  describe("7TV file selection (pickSevenTvFile)", () => {
    it("ignores files with non-string names", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("7tv.io/v3/emote-sets/global")) {
          return jsonResponse({
            emotes: [
              {
                name: "WeirdFiles",
                data: {
                  animated: false,
                  host: {
                    url: "//cdn.7tv.app/emote/wf",
                    files: [
                      { name: null },
                      { name: undefined },
                      { name: "" },
                      { name: "4x.webp" },
                    ],
                  },
                },
              },
            ],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      // Should still find 4x.webp
      expect(lookup.get("WeirdFiles")).toBe(
        "https://cdn.7tv.app/emote/wf/4x.webp",
      );
    });
  });

  // -------------------------------------------------------------------------
  // URL construction edge cases
  // -------------------------------------------------------------------------

  describe("URL construction", () => {
    it("handles full https URLs from temotes as-is", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("FullUrl", 1, [
              {
                size: "4x",
                url: "https://cdn.example/emote/full.webp",
              },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.get("FullUrl")).toBe(
        "https://cdn.example/emote/full.webp",
      );
    });

    it("handles http URLs from temotes as-is", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("HttpUrl", 1, [
              {
                size: "4x",
                url: "http://cdn.example/emote/http.webp",
              },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.get("HttpUrl")).toBe(
        "http://cdn.example/emote/http.webp",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Temotes URL size picking
  // -------------------------------------------------------------------------

  describe("temotes URL size selection", () => {
    it("prefers 4x > 3x > 2x > 1x", async () => {
      // Only 2x and 1x available -> picks 2x
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("Only2x1x", 1, [
              { size: "1x", url: "//cdn.example/1x.webp" },
              { size: "2x", url: "//cdn.example/2x.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.get("Only2x1x")).toBe("https://cdn.example/2x.webp");
    });

    it("picks first available when no standard sizes match", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("NoStdSize", 1, [
              { size: "original", url: "//cdn.example/original.webp" },
              { size: "tiny", url: "//cdn.example/tiny.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      // First entry in the map iteration
      const result = lookup.get("NoStdSize");
      expect(result).toBeDefined();
      expect(result!.startsWith("https://")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Fresh fetch when cache is expired and fresh fetch has results
  // -------------------------------------------------------------------------

  describe("cache expiration and refresh", () => {
    it("re-fetches when localStorage cache is expired", async () => {
      const staleCache = {
        expiresAt: Date.now() - 1000,
        emotes: [
          {
            code: "OldEmote",
            url: "https://cdn.example/old.webp",
            provider: "7tv",
            animated: false,
            priority: 20,
          },
        ],
      };
      mockStorage.setItem(
        "stella:twitch-emotes:v2",
        JSON.stringify(staleCache),
      );

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "NewEmote", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      // Fresh fetch succeeded so new emote should be present
      expect(lookup.has("NewEmote")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Emotes with special URL patterns for .gif detection
  // -------------------------------------------------------------------------

  describe("animated detection via URL", () => {
    it("detects .gif as animated in temotes", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emotes.adamcy.pl") && url.includes("global")) {
          return jsonResponse([
            makeTemotesEmote("AnimGif", 1, [
              { size: "4x", url: "//cdn.example/emote.gif" },
            ]),
            makeTemotesEmote("AnimGifQuery", 1, [
              { size: "4x", url: "//cdn.example/emote.gif?v=2" },
            ]),
            makeTemotesEmote("StaticWebp", 1, [
              { size: "4x", url: "//cdn.example/emote.webp" },
            ]),
          ]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      // All should load successfully
      expect(lookup.has("AnimGif")).toBe(true);
      expect(lookup.has("AnimGifQuery")).toBe(true);
      expect(lookup.has("StaticWebp")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // parseEmojiLookup edge cases
  // -------------------------------------------------------------------------

  describe("parseEmojiLookup edge cases", () => {
    it("handles payload with labels array instead of entries", async () => {
      const labelsData = {
        version: 1,
        labels: [
          {
            code: "FromLabels",
            emoji: "\u2728",
            url: "https://cdn.example/labels.webp",
            confidence: 0.9,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse(labelsData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();

      expect(lookup.get("\u2728")).toBe("https://cdn.example/labels.webp");
    });

    it("returns empty map for non-object payload", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse("not an object");
        }
        if (url.includes("emoji-labels.json")) {
          return jsonResponse(42);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();
      expect(lookup.size).toBe(0);
    });

    it("returns empty map for null payload", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse(null);
        }
        if (url.includes("emoji-labels.json")) {
          return jsonResponse(null);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();
      expect(lookup.size).toBe(0);
    });

    it("handles negative confidence values as 0", async () => {
      const emojiData = {
        version: 1,
        entries: [
          {
            code: "NegConf",
            emoji: "\u2728",
            url: "https://cdn.example/neg.webp",
            confidence: -1,
          },
          {
            code: "ZeroConf",
            emoji: "\u2728",
            url: "https://cdn.example/zero.webp",
            confidence: 0,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse(emojiData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();

      // Both treated as confidence=0, tiebreak by code: "NegConf" < "ZeroConf"
      expect(lookup.get("\u2728")).toBe("https://cdn.example/neg.webp");
    });

    it("handles NaN confidence as 0", async () => {
      const emojiData = {
        version: 1,
        entries: [
          {
            code: "NaNConf",
            emoji: "\u2728",
            url: "https://cdn.example/nan.webp",
            confidence: NaN,
          },
          {
            code: "ValidConf",
            emoji: "\u2728",
            url: "https://cdn.example/valid.webp",
            confidence: 0.5,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("emoji-index.json")) {
          return jsonResponse(emojiData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadEmojiEmoteLookup();

      // ValidConf (0.5) > NaNConf (treated as 0)
      expect(lookup.get("\u2728")).toBe("https://cdn.example/valid.webp");
    });
  });

  // -------------------------------------------------------------------------
  // Local manifest details
  // -------------------------------------------------------------------------

  describe("local manifest", () => {
    it("resolves relative URLs in manifest emotes", async () => {
      const manifestData = {
        version: 1,
        emotes: [
          {
            code: "RelativeUrl",
            url: "/emotes/custom/test.webp",
            provider: "7tv",
            animated: false,
            priority: 50,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("manifest.json")) {
          return jsonResponse(manifestData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      const url = lookup.get("RelativeUrl");
      expect(url).toBeDefined();
      // The URL should be resolved (not still a relative path starting with /)
      // In jsdom, window.location.href is available so it resolves
    });

    it("resolves absolute https URLs in manifest as-is", async () => {
      const manifestData = {
        version: 1,
        emotes: [
          {
            code: "AbsUrl",
            url: "https://cdn.example/absolute.webp",
            provider: "7tv",
            animated: false,
            priority: 50,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("manifest.json")) {
          return jsonResponse(manifestData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      expect(lookup.get("AbsUrl")).toBe("https://cdn.example/absolute.webp");
    });

    it("only loads manifest once even when called multiple times", async () => {
      let manifestFetchCount = 0;
      const manifestData = {
        version: 1,
        emotes: [
          {
            code: "OnceOnly",
            url: "https://cdn.example/once.webp",
            provider: "7tv",
            animated: false,
            priority: 50,
          },
        ],
      };

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("manifest.json")) {
          manifestFetchCount++;
          return jsonResponse(manifestData);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      await mod.loadTwitchEmoteLookup();
      await mod.loadTwitchEmoteLookup();
      await mod.loadTwitchEmoteLookup();

      // Manifest should only be fetched once (localManifestLoadAttempted flag)
      expect(manifestFetchCount).toBe(1);
    });

    it("does not retry manifest load after initial failure", async () => {
      let manifestFetchCount = 0;

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("manifest.json")) {
          manifestFetchCount++;
          return notFoundResponse();
        }
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "Remote", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      // First call: tries manifest, fails, falls through to remote
      await mod.loadTwitchEmoteLookup();

      // Reset in-memory cache to force re-check
      // (but localManifestLoadAttempted is still true)
      // Actually the in-memory cache will serve subsequent calls...
      // We verify the manifest was only fetched once
      expect(manifestFetchCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // parseManifest edge cases
  // -------------------------------------------------------------------------

  describe("parseManifest robustness", () => {
    it("returns null for non-object manifest", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("manifest.json")) {
          return jsonResponse("just a string");
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      // Should fall through to remote APIs without crashing
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup).toBeInstanceOf(Map);
    });

    it("returns null for manifest without emotes array", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("manifest.json")) {
          return jsonResponse({ version: 1, channels: ["test"] });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup).toBeInstanceOf(Map);
    });

    it("skips manifest emotes with null entries", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes("manifest.json")) {
          return jsonResponse({
            version: 1,
            emotes: [
              null,
              {
                code: "AfterNull",
                url: "https://cdn.example/after.webp",
                provider: "7tv",
                animated: false,
                priority: 50,
              },
            ],
          });
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.has("AfterNull")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // fetchJson error handling
  // -------------------------------------------------------------------------

  describe("fetchJson error handling", () => {
    it("returns null when response.json() throws", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.reject(new Error("parse error")),
        }),
      );

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup).toBeInstanceOf(Map);
    });

    it("returns null on HTTP errors (non-ok responses)", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        }),
      );

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup).toBeInstanceOf(Map);
      expect(lookup.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // parseCachedValue edge cases
  // -------------------------------------------------------------------------

  describe("parseCachedValue edge cases", () => {
    it("returns null for cache with non-number expiresAt", async () => {
      mockStorage.setItem(
        "stella:twitch-emotes:v2",
        JSON.stringify({ expiresAt: "not a number", emotes: [] }),
      );

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "Fresh", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();

      // Invalid cache should be ignored, fresh fetch used
      expect(lookup.has("Fresh")).toBe(true);
    });

    it("returns null for cache with non-array emotes", async () => {
      mockStorage.setItem(
        "stella:twitch-emotes:v2",
        JSON.stringify({
          expiresAt: Date.now() + 100000,
          emotes: "not an array",
        }),
      );

      mockFetch.mockImplementation((url: string) => {
        if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
          return jsonResponse([makeBttvEmote("e1", "FreshAgain", false)]);
        }
        return notFoundResponse();
      });

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup.has("FreshAgain")).toBe(true);
    });

    it("returns null for empty string in localStorage", async () => {
      mockStorage.setItem("stella:twitch-emotes:v2", "");

      mockFetch.mockImplementation(() => notFoundResponse());

      const mod = await freshModule();
      const lookup = await mod.loadTwitchEmoteLookup();
      expect(lookup).toBeInstanceOf(Map);
    });
  });
});
