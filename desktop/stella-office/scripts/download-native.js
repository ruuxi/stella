#!/usr/bin/env node

import {
  createWriteStream,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { get } from "node:https";
import {
  ensureBinDir,
  finalizeBundledBinary,
  getBundledBinaryPath,
  getOfficeCliAssetName,
} from "./shared.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const version = packageJson.version;
const assetName = getOfficeCliAssetName();
const targetPath = getBundledBinaryPath();
const downloadUrl = `https://github.com/iOfficeAI/OfficeCLI/releases/download/v${version}/${assetName}`;

const downloadFile = async (url, destination) =>
  await new Promise((resolve, reject) => {
    const file = createWriteStream(destination);

    const request = (currentUrl) => {
      get(currentUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          request(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      }).on("error", (error) => {
        try {
          unlinkSync(destination);
        } catch {}
        reject(error);
      });
    };

    request(url);
  });

ensureBinDir();

if (existsSync(targetPath)) {
  finalizeBundledBinary(targetPath);
  console.log(`stella-office binary already present: ${targetPath}`);
  process.exit(0);
}

console.log(`Downloading ${assetName} from ${downloadUrl}`);

try {
  await downloadFile(downloadUrl, targetPath);
  finalizeBundledBinary(targetPath);
  console.log(`Downloaded native binary to ${targetPath}`);
} catch (error) {
  console.error(`Failed to download native binary: ${error.message}`);
  process.exit(1);
}
