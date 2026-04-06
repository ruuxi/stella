#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { officeCliProjectFile, projectRoot } from "./shared.js";

const csproj = readFileSync(officeCliProjectFile, "utf8");
const versionMatch = csproj.match(/<Version>([^<]+)<\/Version>/);

if (!versionMatch) {
  console.error(`Could not find <Version> in ${officeCliProjectFile}`);
  process.exit(1);
}

const version = versionMatch[1].trim();
const packageJsonPath = join(projectRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

if (packageJson.version === version) {
  console.log(`stella-office version already synced to ${version}`);
  process.exit(0);
}

packageJson.version = version;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`Synced stella-office version to ${version}`);
