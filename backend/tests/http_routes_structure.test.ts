import { describe, test, expect } from "bun:test";
import * as fs from "fs";

describe("http_routes module structure", () => {
  const routeFiles = [
    { file: "convex/http_routes/connectors.ts", export: "registerConnectorWebhookRoutes" },
    { file: "convex/http_routes/music.ts", export: "registerMusicRoutes" },
    { file: "convex/http_routes/skills.ts", export: "registerSkillRoutes" },
    { file: "convex/http_routes/synthesis.ts", export: "registerSynthesisRoutes" },
    { file: "convex/http_routes/voice.ts", export: "registerVoiceRoutes" },
  ];

  for (const { file, export: exportName } of routeFiles) {
    test(`${file} exports ${exportName}`, () => {
      const source = fs.readFileSync(file, "utf-8");
      expect(source).toContain(`export const ${exportName}`);
    });
  }

  test("connectors.ts handles multiple providers", () => {
    const source = fs.readFileSync("convex/http_routes/connectors.ts", "utf-8");
    expect(source).toContain("slack");
    expect(source).toContain("telegram");
    expect(source).toContain("discord");
  });

  test("music.ts exposes a backend-owned music stream instead of returning raw keys", () => {
    const source = fs.readFileSync("convex/http_routes/music.ts", "utf-8");
    expect(source).toContain("/api/music/stream");
    expect(source).toContain("text/event-stream");
    expect(source).not.toContain("return jsonResponse({ apiKey }, 200, origin)");
  });

  test("connectors.ts does not expose removed bridge routes", () => {
    const source = fs.readFileSync("convex/http_routes/connectors.ts", "utf-8");
    expect(source).not.toContain("/api/bridge/poll");
    expect(source).not.toContain("/api/webhooks/bridge");
  });

  test("all route files register HTTP routes", () => {
    for (const { file } of routeFiles) {
      const source = fs.readFileSync(file, "utf-8");
      expect(source).toContain("http.route");
    }
  });
});
