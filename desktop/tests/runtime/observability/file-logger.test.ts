import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FileLogger } from "../../../../runtime/observability/file-logger.js";
import { scrubText } from "../../../../runtime/observability/scrub.js";

const makeLogger = async (retentionDays?: number) => {
  const logDir = await mkdtemp(path.join(tmpdir(), "stella-logs-"));
  const logger = new FileLogger({
    logDir,
    component: "test",
    ...(retentionDays != null ? { retentionDays } : {}),
  });
  return { logDir, logger };
};

describe("scrubText", () => {
  it("redacts emails, tokens, keys, and long blobs", () => {
    expect(scrubText("user me@example.com signed in")).toContain("<email>");
    expect(scrubText("Authorization: Bearer abcdef123456")).toContain(
      "<redacted-token>",
    );
    expect(scrubText("key sk-ABCDEFGHIJKLMNOPQRSTUV done")).toContain(
      "<redacted-key>",
    );
    expect(
      scrubText("api_key=supersecretvalue123 trailing"),
    ).toContain("<redacted>");
    const blob = "A".repeat(80);
    expect(scrubText(`blob ${blob}`)).toContain("<redacted>");
  });

  it("leaves ordinary diagnostic text intact", () => {
    expect(scrubText("worker.listening pid=4231 reason=idle")).toBe(
      "worker.listening pid=4231 reason=idle",
    );
  });
});

describe("FileLogger", () => {
  it("writes process events to a dated process file", async () => {
    const { logDir, logger } = await makeLogger();
    try {
      logger.process("worker.listening", { pid: 123 });
      const files = await readdir(logDir);
      const processFile = files.find((f) => f.startsWith("process-"));
      expect(processFile).toBeDefined();
      const contents = await readFile(path.join(logDir, processFile!), "utf-8");
      expect(contents).toContain("worker.listening");
      expect(contents).toContain("pid=123");
      expect(contents).toContain("[info]");
      expect(contents).toContain("[test]");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("scrubs sensitive field values before writing", async () => {
    const { logDir, logger } = await makeLogger();
    try {
      logger.error("auth.failed", {
        detail: "token Bearer abcdef123456 for me@example.com",
      });
      const files = await readdir(logDir);
      const errorFile = files.find((f) => f.startsWith("error-"));
      const contents = await readFile(path.join(logDir, errorFile!), "utf-8");
      expect(contents).not.toContain("abcdef123456");
      expect(contents).not.toContain("me@example.com");
      expect(contents).toContain("<redacted-token>");
      expect(contents).toContain("<email>");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("scrubs a stack passed as a field (renderer error path)", async () => {
    const { logDir, logger } = await makeLogger();
    try {
      logger.error("renderer.error", {
        kind: "window.onerror",
        stack:
          "Error: boom Bearer abcdef123456 me@example.com\n  at foo (app.js:1:1)",
      });
      const files = await readdir(logDir);
      const errorFile = files.find((f) => f.startsWith("error-"));
      const contents = await readFile(path.join(logDir, errorFile!), "utf-8");
      expect(contents).not.toContain("abcdef123456");
      expect(contents).not.toContain("me@example.com");
      expect(contents).toContain("<redacted-token>");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("records a scrubbed stack on crash", async () => {
    const { logDir, logger } = await makeLogger();
    try {
      logger.crash("worker.fatal", new Error("boom at sk-ABCDEFGHIJKLMNOPQRST"));
      const files = await readdir(logDir);
      const errorFile = files.find((f) => f.startsWith("error-"));
      const contents = await readFile(path.join(logDir, errorFile!), "utf-8");
      expect(contents).toContain("[fatal]");
      expect(contents).toContain("worker.fatal");
      expect(contents).not.toContain("sk-ABCDEFGHIJKLMNOPQRST");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("deletes log files older than the retention window on rollover", async () => {
    const { logDir, logger } = await makeLogger(7);
    try {
      // Seed a stale file dated/aged well beyond the retention window.
      const stale = path.join(logDir, "process-2000-01-01.txt");
      await writeFile(stale, "old line\n");
      const old = new Date("2000-01-01T00:00:00Z");
      await utimes(stale, old, old);

      // First write of the day rolls over and sweeps retention.
      logger.process("worker.listening", { pid: 1 });

      const files = await readdir(logDir);
      expect(files).not.toContain("process-2000-01-01.txt");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("enforces a total-size budget by deleting oldest files first", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "stella-logs-"));
    try {
      // Three recent (within retention) files, each 4KB, oldest -> newest.
      const seed = async (name: string, ageMs: number) => {
        const filePath = path.join(logDir, name);
        await writeFile(filePath, "x".repeat(4096));
        const t = new Date(Date.now() - ageMs);
        await utimes(filePath, t, t);
      };
      await seed("process-2024-01-01.txt", 3 * 60_000);
      await seed("error-2024-01-02.txt", 2 * 60_000);
      await seed("process-2024-01-03.txt", 1 * 60_000);

      // Budget of 6KB forces deletion of the oldest file(s).
      const logger = new FileLogger({
        logDir,
        component: "test",
        retentionDays: 3650,
        maxTotalBytes: 6 * 1024,
      });
      logger.process("worker.listening", { pid: 1 });

      const files = await readdir(logDir);
      // Oldest file deleted to get back under the total budget.
      expect(files).not.toContain("process-2024-01-01.txt");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("does not throw when the log directory cannot be created", async () => {
    const logger = new FileLogger({
      // A path under a file (not a dir) so mkdir fails.
      logDir: path.join(tmpdir(), "stella-logger.test", "nope", "\0bad"),
      component: "test",
    });
    expect(() => logger.process("noop")).not.toThrow();
  });
});
