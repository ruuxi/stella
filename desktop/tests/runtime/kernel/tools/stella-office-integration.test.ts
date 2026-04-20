import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createShellState,
  runShell,
} from "../../../../../runtime/kernel/tools/shell.js";

const officeWrapperPath = path.resolve(
  process.cwd(),
  "stella-office",
  "bin",
  "stella-office.js",
);
const runIfOfficeBinary = existsSync(officeWrapperPath) ? it : it.skip;
const OFFICE_INTEGRATION_TEST_TIMEOUT_MS = 20_000;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

const createTempDir = () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-office-test-"));
  tempDirs.push(tempDir);
  return tempDir;
};

const createOfficeShellState = () =>
  createShellState(async () => null, os.tmpdir(), {
    stellaOfficeBinPath: officeWrapperPath,
  });

const runOffice = async (cwd: string, command: string) => {
  const output = await runShell(createOfficeShellState(), command, cwd, 20_000);
  expect(output).not.toContain("Command exited with code");
  return output;
};

describe("stella-office integration", () => {
  runIfOfficeBinary(
    "creates and reads a docx document",
    async () => {
      const tempDir = createTempDir();

      await runOffice(tempDir, "stella-office create smoke.docx");
      await runOffice(
        tempDir,
        'stella-office add smoke.docx /body --type paragraph --prop text="Hello from Stella"',
      );
      const output = await runOffice(
        tempDir,
        "stella-office get smoke.docx '/body/p[1]' --json",
      );

      expect(output).toContain("Hello from Stella");
    },
    OFFICE_INTEGRATION_TEST_TIMEOUT_MS,
  );

  runIfOfficeBinary(
    "creates and reads an xlsx document",
    async () => {
      const tempDir = createTempDir();

      await runOffice(tempDir, "stella-office create smoke.xlsx");
      await runOffice(
        tempDir,
        'stella-office set smoke.xlsx /Sheet1/A1 --prop value="Score"',
      );
      const output = await runOffice(
        tempDir,
        "stella-office get smoke.xlsx '/Sheet1/A1' --json",
      );

      expect(output).toContain("Score");
    },
    OFFICE_INTEGRATION_TEST_TIMEOUT_MS,
  );

  runIfOfficeBinary(
    "creates and reads a pptx document",
    async () => {
      const tempDir = createTempDir();

      await runOffice(tempDir, "stella-office create smoke.pptx");
      await runOffice(
        tempDir,
        'stella-office add smoke.pptx / --type slide --prop title="Hello Stella"',
      );
      const output = await runOffice(
        tempDir,
        "stella-office get smoke.pptx '/slide[1]' --depth 1 --json",
      );

      expect(output).toContain("Hello Stella");
    },
    OFFICE_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
