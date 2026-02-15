export type BridgeBundle = {
  code: string;
  env: Record<string, string>;
  dependencies: string;
};

export type BridgeProvider = "whatsapp" | "signal";

export type GetBridgeBundle = (args: {
  provider: BridgeProvider;
}) => Promise<BridgeBundle>;

export async function deployAndStartLocalBridge(
  provider: BridgeProvider,
  getBridgeBundle: GetBridgeBundle,
): Promise<boolean> {
  const electronApi = window.electronAPI;
  if (!electronApi) {
    return false;
  }

  const rawBundle = await getBridgeBundle({ provider }) as
    | BridgeBundle
    | (BridgeBundle & { config?: string });
  const bundleEnv =
    rawBundle.env ??
    (() => {
      if (!rawBundle.config) return {};
      try {
        return JSON.parse(rawBundle.config) as Record<string, string>;
      } catch {
        return {};
      }
    })();

  const deployResult = await electronApi.bridgeDeploy({
    provider,
    code: rawBundle.code,
    env: bundleEnv,
    dependencies: rawBundle.dependencies,
  });
  if (!deployResult.ok) {
    throw new Error(deployResult.error ?? "Failed to deploy bridge locally");
  }

  const startResult = await electronApi.bridgeStart({ provider });
  if (!startResult.ok) {
    throw new Error(startResult.error ?? "Failed to start bridge locally");
  }

  return true;
}
