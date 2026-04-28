/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

let projectRoot = "";

/** Stella sets this to `~/.stella/google-workspace` before loading Google Workspace tools. */
export function setGoogleWorkspaceProjectRoot(root: string): void {
  projectRoot = root;
}

export function getProjectRoot(): string {
  return projectRoot;
}
