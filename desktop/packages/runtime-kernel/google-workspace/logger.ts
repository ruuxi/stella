/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectRoot } from "./paths.js";

let isLoggingEnabled = false;

export function setLoggingEnabled(enabled: boolean) {
  isLoggingEnabled = enabled;
}

export function logToFile(message: string) {
  if (!isLoggingEnabled) {
    return;
  }
  const root = getProjectRoot();
  if (!root) {
    return;
  }
  const logFilePath = path.join(root, "logs", "server.log");
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} - ${message}\n`;

  void fs.mkdir(path.dirname(logFilePath), { recursive: true }).then(() =>
    fs.appendFile(logFilePath, logMessage).catch((err) => {
      console.error("Failed to write to log file:", err);
    }),
  );
}
