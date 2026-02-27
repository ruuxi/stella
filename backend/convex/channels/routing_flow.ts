import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type AccountMode = "private_local" | "connected";
export type DmPolicyConfig = {
  policy: DmPolicy;
  allowlist: string[];
  denylist: string[];
};

export type ChannelConnection = {
  _id: Id<"channel_connections">;
  _creationTime: number;
  ownerId: string;
  provider: string;
  externalUserId: string;
  conversationId?: Id<"conversations">;
  displayName?: string;
  linkedAt: number;
  updatedAt: number;
};

type QueryRunnerCtx = Pick<ActionCtx, "runQuery">;
type QueryMutationRunnerCtx = Pick<ActionCtx, "runQuery" | "runMutation">;

export const ACCOUNT_MODE_CONNECTED: AccountMode = "connected";
export const CONNECTED_MODE_REQUIRED_ERROR =
  "Connectors require Connected mode. Enable Connected mode in Settings.";

export const isOwnerInConnectedMode = async (args: {
  ctx: QueryRunnerCtx;
  ownerId: string;
}): Promise<boolean> => {
  const accountMode = await args.ctx.runQuery(
    internal.data.preferences.getAccountModeForOwner,
    { ownerId: args.ownerId },
  );
  return accountMode === ACCOUNT_MODE_CONNECTED;
};

export const findConnection = async (args: {
  ctx: QueryRunnerCtx;
  ownerId?: string;
  provider: string;
  externalUserId: string;
}): Promise<ChannelConnection | null> => {
  if (args.ownerId) {
    return await args.ctx.runQuery(
      internal.channels.utils.getConnectionByOwnerProviderAndExternalId,
      {
        ownerId: args.ownerId,
        provider: args.provider,
        externalUserId: args.externalUserId,
      },
    );
  }

  return await args.ctx.runQuery(
    internal.channels.utils.getConnectionByProviderAndExternalId,
    { provider: args.provider, externalUserId: args.externalUserId },
  );
};

export const ensureOwnerConnection = async (args: {
  ctx: QueryMutationRunnerCtx;
  ownerId: string;
  provider: string;
  externalUserId: string;
  displayName?: string;
}): Promise<ChannelConnection | null> => {
  await args.ctx.runMutation(internal.channels.utils.createConnection, {
    ownerId: args.ownerId,
    provider: args.provider,
    externalUserId: args.externalUserId,
    ...(args.displayName ? { displayName: args.displayName } : {}),
  });

  return await args.ctx.runQuery(
    internal.channels.utils.getConnectionByOwnerProviderAndExternalId,
    {
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: args.externalUserId,
    },
  );
};

export const shouldBlockInboundByDmPolicy = (args: {
  policy: DmPolicyConfig;
  externalUserId: string;
  hasExistingConnection: boolean;
}): boolean => {
  if (args.policy.denylist.includes(args.externalUserId)) return true;
  if (args.policy.policy === "disabled") return true;
  if (
    args.policy.policy === "allowlist" &&
    !args.policy.allowlist.includes(args.externalUserId)
  ) {
    return true;
  }
  if (args.policy.policy === "pairing" && !args.hasExistingConnection) {
    return true;
  }
  return false;
};

export const resolveConnectionForIncomingMessage = async (args: {
  ctx: QueryMutationRunnerCtx;
  ownerId?: string;
  provider: string;
  externalUserId: string;
  displayName?: string;
  preEnsureOwnerConnection?: boolean;
}): Promise<ChannelConnection | null> => {
  let connection: ChannelConnection | null = null;

  if (args.preEnsureOwnerConnection && args.ownerId) {
    connection = await ensureOwnerConnection({
      ctx: args.ctx,
      ownerId: args.ownerId,
      provider: args.provider,
      externalUserId: args.externalUserId,
      displayName: args.displayName,
    });
  } else {
    connection = await findConnection(args);
  }

  const policyOwnerId = args.ownerId ?? connection?.ownerId;
  if (!policyOwnerId) {
    return null;
  }

  const policy = (await args.ctx.runQuery(internal.channels.utils.getDmPolicyConfig, {
    ownerId: policyOwnerId,
    provider: args.provider,
  })) as DmPolicyConfig;

  if (
    shouldBlockInboundByDmPolicy({
      policy,
      externalUserId: args.externalUserId,
      hasExistingConnection: Boolean(connection),
    })
  ) {
    return null;
  }

  if (connection) {
    return connection;
  }

  if (!(await isOwnerInConnectedMode({ ctx: args.ctx, ownerId: policyOwnerId }))) {
    return null;
  }

  return await ensureOwnerConnection({
    ctx: args.ctx,
    ownerId: policyOwnerId,
    provider: args.provider,
    externalUserId: args.externalUserId,
    displayName: args.displayName,
  });
};

export const evaluateLinkingDmPolicy = (args: {
  policy: DmPolicyConfig;
  externalUserId: string;
}): "linking_disabled" | "not_allowed" | null => {
  if (args.policy.policy === "disabled") {
    return "linking_disabled";
  }
  if (args.policy.denylist.includes(args.externalUserId)) {
    return "not_allowed";
  }
  if (
    args.policy.policy === "allowlist" &&
    !args.policy.allowlist.includes(args.externalUserId)
  ) {
    return "not_allowed";
  }
  return null;
};
