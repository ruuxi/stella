export type BridgeBundle = {
  code: string;
  config: string;
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

  const bundle = await getBridgeBundle({ provider });
  const deployResult = await electronApi.bridgeDeploy({
    provider,
    code: bundle.code,
    config: bundle.config,
    dependencies: bundle.dependencies,
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
