import { describe, expect, it } from "vitest";

import {
  BrowserCommandRunnerError,
  runBrowserCommand,
} from "../../../../../runtime/kernel/browser-use/command-runner.js";

const request = (args: string[]) => ({
  command: process.execPath,
  args,
  cwd: process.cwd(),
  env: process.env,
  timeoutMs: 2_000,
  maxOutputBytes: 1_024,
});

describe("browser daemon startup fallback runner", () => {
  it("captures normal stdout and stderr", async () => {
    await expect(
      runBrowserCommand(
        request([
          "-e",
          "process.stdout.write('ready'); process.stderr.write('notice')",
        ]),
      ),
    ).resolves.toEqual({ exitCode: 0, stdout: "ready", stderr: "notice" });
  });

  it("terminates fallback commands whose combined output exceeds the bound", async () => {
    const error = await runBrowserCommand(
      request(["-e", "process.stderr.write('x'.repeat(4096))"]),
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(BrowserCommandRunnerError);
    expect(error).toMatchObject({
      code: "output_limit",
      stderr: expect.any(String),
    });
    expect((error as BrowserCommandRunnerError).stderr.length).toBe(1_024);
  });

  it("supports timeout and AbortSignal cancellation", async () => {
    await expect(
      runBrowserCommand({
        ...request(["-e", "setTimeout(() => {}, 10000)"]),
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    const reason = new Error("cancel startup");
    const pending = runBrowserCommand({
      ...request(["-e", "setTimeout(() => {}, 10000)"]),
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
