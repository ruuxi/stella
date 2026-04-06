import { existsSync, mkdirSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const projectRoot = join(__dirname, "..");
export const binDir = join(projectRoot, "bin");
export const officeCliRoot = join(projectRoot, "vendor", "officecli");
export const officeCliBuildScript = join(officeCliRoot, "build.sh");
export const officeCliProjectFile = join(
  officeCliRoot,
  "src",
  "officecli",
  "officecli.csproj",
);

export const getPlatformKey = () => `${platform()}-${arch()}`;

export const getBinaryTargetName = () => {
  const ext = platform() === "win32" ? ".exe" : "";
  return `stella-office-${getPlatformKey()}${ext}`;
};

export const getOfficeCliAssetName = () => {
  if (platform() === "darwin") {
    return arch() === "arm64" ? "officecli-mac-arm64" : "officecli-mac-x64";
  }

  if (platform() === "linux") {
    return arch() === "arm64" ? "officecli-linux-arm64" : "officecli-linux-x64";
  }

  if (platform() === "win32") {
    return arch() === "arm64" ? "officecli-win-arm64.exe" : "officecli-win-x64.exe";
  }

  throw new Error(`Unsupported platform: ${platform()}-${arch()}`);
};

export const getOfficeCliReleaseBinaryPath = () =>
  join(officeCliRoot, "bin", "release", getOfficeCliAssetName());

export const getBundledBinaryPath = () => join(binDir, getBinaryTargetName());

export const ensureBinDir = () => {
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }
};
