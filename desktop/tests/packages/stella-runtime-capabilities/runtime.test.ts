import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapabilityRuntime } from "../../../packages/stella-runtime-capabilities/src/runtime.js";
import type {
  CapabilityStateApi,
} from "../../../packages/stella-runtime-capabilities/src/types.js";

const tempDirs: string[] = [];

const createTempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const createStateApi = (): CapabilityStateApi => ({
  get: vi.fn(async () => null),
  set: vi.fn(async ({ moduleId, scope, entityId, key, jsonValue }) => ({
    moduleId,
    scope,
    entityId: entityId ?? "",
    key,
    jsonValue,
    updatedAt: Date.now(),
  })),
  appendEvent: vi.fn(async ({ moduleId, scope, entityId, eventType, jsonValue }) => ({
    id: 1,
    moduleId,
    scope,
    entityId: entityId ?? "",
    eventType,
    jsonValue,
    createdAt: Date.now(),
  })),
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("CapabilityRuntime", () => {
  it("loads built-in and markdown commands from writable roots", async () => {
    const frontendRoot = createTempDir("stella-cap-runtime-frontend-");
    const stellaHomePath = createTempDir("stella-cap-runtime-home-");
    const bundledCommandsDir = path.join(frontendRoot, "resources", "bundled-commands");
    const userCommandsDir = path.join(stellaHomePath, "commands");

    fs.mkdirSync(path.join(bundledCommandsDir, "team"), { recursive: true });
    fs.mkdirSync(userCommandsDir, { recursive: true });

    fs.writeFileSync(
      path.join(bundledCommandsDir, "team", "hello.md"),
      `---
description: Team hello
argument-hint: <name>
---
Hello from bundled commands.`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(userCommandsDir, "custom.md"),
      `---
description: Custom hello
---
Hello from the writable home command root.`,
      "utf8",
    );

    const runtime = new CapabilityRuntime({
      frontendRoot,
      stellaHomePath,
      getProxy: () => null,
      host: {
        ui: {
          snapshot: async () => "<snapshot />",
          observe: async () => "<observe />",
          act: async ({ action, ref, value }) =>
            `${action}:${ref}${value ? `:${value}` : ""}`,
        },
      },
      state: createStateApi(),
    });

    await runtime.load();

    expect(runtime.listCommands()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "stella-ui", sourcePath: "builtin:stella-ui" }),
        expect.objectContaining({ id: "team.hello", description: "Team hello" }),
        expect.objectContaining({ id: "custom", description: "Custom hello" }),
      ]),
    );
    expect(runtime.getLoadedSourcePaths()).toEqual(
      expect.arrayContaining([
        "builtin:stella-ui",
        path.join(bundledCommandsDir, "team", "hello.md"),
        path.join(userCommandsDir, "custom.md"),
      ]),
    );

    const markdownResult = await runtime.runCommand({
      id: "team.hello",
      argv: ["Stella"],
    });
    const builtInResult = await runtime.runCommand({
      id: "stella-ui",
      argv: ["snapshot"],
    });

    expect(markdownResult).toEqual({
      exitCode: 0,
      stdout: "Hello from bundled commands.\n\nArguments:\nStella",
    });
    expect(builtInResult).toEqual({
      exitCode: 0,
      stdout: "<snapshot />",
    });
  });

  it("skips malformed markdown commands and accepts CRLF frontmatter", async () => {
    const frontendRoot = createTempDir("stella-cap-runtime-frontend-");
    const stellaHomePath = createTempDir("stella-cap-runtime-home-");
    const bundledCommandsDir = path.join(frontendRoot, "resources", "bundled-commands");
    const userCommandsDir = path.join(stellaHomePath, "commands");

    fs.mkdirSync(path.join(bundledCommandsDir, "windows"), { recursive: true });
    fs.mkdirSync(userCommandsDir, { recursive: true });

    fs.writeFileSync(
      path.join(bundledCommandsDir, "windows", "hello.md"),
      [
        "---",
        "description: Windows hello",
        "argument-hint: <name>",
        "---",
        "Hello from a CRLF command.",
      ].join("\r\n"),
      "utf8",
    );
    const malformedCommandPath = path.join(userCommandsDir, "broken.md");
    fs.writeFileSync(
      malformedCommandPath,
      `---
description: Broken command
argument-hint: [unterminated
---
This command should be skipped.`,
      "utf8",
    );

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const runtime = new CapabilityRuntime({
        frontendRoot,
        stellaHomePath,
        getProxy: () => null,
        host: {
          ui: {
            snapshot: async () => "<snapshot />",
            observe: async () => "<observe />",
            act: async ({ action, ref, value }) =>
              `${action}:${ref}${value ? `:${value}` : ""}`,
          },
        },
        state: createStateApi(),
      });

      await runtime.load();

      expect(runtime.listCommands()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "stella-ui", sourcePath: "builtin:stella-ui" }),
          expect.objectContaining({
            id: "windows.hello",
            description: "Windows hello",
            argumentHint: "<name>",
          }),
        ]),
      );
      expect(runtime.listCommands()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "broken" })]),
      );
      expect(runtime.getLoadedSourcePaths()).toEqual(
        expect.arrayContaining([
          "builtin:stella-ui",
          path.join(bundledCommandsDir, "windows", "hello.md"),
        ]),
      );
      expect(runtime.getLoadedSourcePaths()).not.toContain(malformedCommandPath);

      const markdownResult = await runtime.runCommand({
        id: "windows.hello",
        argv: ["Stella"],
      });

      expect(markdownResult).toEqual({
        exitCode: 0,
        stdout: "Hello from a CRLF command.\n\nArguments:\nStella",
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Skipping markdown command "${malformedCommandPath}"`),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
