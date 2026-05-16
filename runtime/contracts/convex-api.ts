import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import type { Value } from "convex/values";

type Id<_TableName extends string> = string;

export const api: PublicApiType = anyApi as unknown as PublicApiType;

export type PublicApiType = {
  "agent": {
    "agents": {
      "upsertMany": FunctionReference<'mutation', 'public', { agents: { name?: string | undefined; description?: string | undefined; systemPrompt?: string | undefined; agentTypes?: string | string[] | undefined; toolsAllowlist?: string | string[] | undefined; maxAgentDepth?: number | undefined; version?: number | undefined; source?: string | undefined; id: string; }[]; }, any, string | undefined>;
    };
    "device_resolver": {
      "heartbeat": FunctionReference<'mutation', 'public', { deviceName?: string | undefined; platform?: string | undefined; deviceId: string; publicKey: string; signedAtMs: number; signature: string; }, any, string | undefined>;
      "registerDevice": FunctionReference<'mutation', 'public', { deviceName?: string | undefined; platform?: string | undefined; deviceId: string; }, any, string | undefined>;
      "goOffline": FunctionReference<'mutation', 'public', { deviceId: string; }, any, string | undefined>;
    };
    "local_runtime": {
      "executeTool": FunctionReference<'action', 'public', { conversationId?: Id<'conversations'> | undefined; agentType?: string | undefined; toolArgs?: Value | undefined; toolName: string; }, any, string | undefined>;
      "webSearch": FunctionReference<'action', 'public', { conversationId?: Id<'conversations'> | undefined; agentType?: string | undefined; category?: string | undefined; query: string; }, any, string | undefined>;
      "shopifySearchProducts": FunctionReference<'action', 'public', { limit?: number | undefined; context?: string | undefined; savedCatalog?: string | undefined; query: string; }, any, string | undefined>;
      "shopifyDebugSearchProducts": FunctionReference<'action', 'public', { limit?: number | undefined; context?: string | undefined; savedCatalog?: string | undefined; query: string; }, any, string | undefined>;
      "shopifyGetProductDetails": FunctionReference<'action', 'public', { productId: string; }, any, string | undefined>;
      "shopifyCreateCheckout": FunctionReference<'action', 'public', { merchantOrigin: string; lines: { quantity: number; variantId: string; }[]; }, any, string | undefined>;
      "shopifyUpdateCheckout": FunctionReference<'action', 'public', { mcpEndpoint: string; checkoutId: string; lines: { quantity: number; variantId: string; }[]; }, any, string | undefined>;
      "shopifyCancelCheckout": FunctionReference<'action', 'public', { mcpEndpoint: string; checkoutId: string; }, any, string | undefined>;
      "fashionRegisterOutfit": FunctionReference<'action', 'public', { stylePrompt?: string | undefined; themeDescription?: string | undefined; tryOnPrompt?: string | undefined; ordinal: number; batchId: string; themeLabel: string; products: { currency?: string | undefined; price?: number | undefined; imageUrl?: string | undefined; productUrl?: string | undefined; checkoutUrl?: string | undefined; vendor?: string | undefined; title: string; slot: string; productId: string; variantId: string; merchantOrigin: string; }[]; }, any, string | undefined>;
      "fashionMarkOutfitReady": FunctionReference<'action', 'public', { tryOnImagePath?: string | undefined; tryOnImageUrl?: string | undefined; outfitId: Id<'fashion_outfits'>; }, any, string | undefined>;
      "fashionMarkOutfitFailed": FunctionReference<'action', 'public', { errorMessage: string; outfitId: Id<'fashion_outfits'>; }, any, string | undefined>;
      "fashionGetOrchestratorContext": FunctionReference<'action', 'public', {}, any, string | undefined>;
    };
    "prompt_builder": {
      "fetchAgentContextForRuntime": FunctionReference<'action', 'public', { threadId?: Id<'threads'> | undefined; platform?: string | undefined; maxHistoryMessages?: number | undefined; timezone?: string | undefined; conversationId: Id<'conversations'>; runId: string; agentType: string; }, any, string | undefined>;
      "fetchLocalAgentContextForRuntime": FunctionReference<'action', 'public', { platform?: string | undefined; timezone?: string | undefined; runId: string; agentType: string; }, any, string | undefined>;
    };
  };
  "auth": {
    "getCurrentUser": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "revokeActiveSessions": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
  };
  "billing": {
    "getSubscriptionStatus": FunctionReference<'query', 'public', { now?: number | undefined; }, any, string | undefined>;
    "createCheckoutSession": FunctionReference<'action', 'public', { plan: 'go' | 'pro' | 'plus' | 'ultra'; returnUrl: string; }, { url: string; sessionId: string; }, string | undefined>;
    "createBillingPortalSession": FunctionReference<'action', 'public', { returnUrl: string; }, any, string | undefined>;
    "getCurrentPlan": FunctionReference<'query', 'public', {}, any, string | undefined>;
  };
  "channels": {
    "connector_delivery": {
      "claimRemoteTurn": FunctionReference<'mutation', 'public', { deviceId?: string | undefined; conversationId: Id<'conversations'>; requestId: string; }, any, string | undefined>;
      "completeRemoteTurn": FunctionReference<'mutation', 'public', { deviceId?: string | undefined; conversationId: Id<'conversations'>; text: string; requestId: string; }, any, string | undefined>;
      "sendConnectorFollowup": FunctionReference<'mutation', 'public', { deviceId?: string | undefined; conversationId: Id<'conversations'>; text: string; requestId: string; }, any, string | undefined>;
    };
    "link_codes": {
      "generateLinkCode": FunctionReference<'mutation', 'public', { provider: string; }, any, string | undefined>;
      "verifyLinqLinkCode": FunctionReference<'mutation', 'public', { phoneNumber: string; code: string; }, any, string | undefined>;
    };
    "linq": {
      "sendLinqLinkSms": FunctionReference<'action', 'public', { phoneNumber: string; }, any, string | undefined>;
    };
    "utils": {
      "getConnection": FunctionReference<'query', 'public', { provider: string; }, any, string | undefined>;
      "deleteConnection": FunctionReference<'mutation', 'public', { provider: string; }, any, string | undefined>;
    };
  };
  "conversations": {
    "getOrCreateDefaultConversation": FunctionReference<'mutation', 'public', { title?: string | undefined; }, any, string | undefined>;
    "createConversation": FunctionReference<'mutation', 'public', { title?: string | undefined; }, any, string | undefined>;
  };
  "data": {
    "attachments": {
      "createFromDataUrl": FunctionReference<'action', 'public', { conversationId: Id<'conversations'>; deviceId: string; dataUrl: string; }, any, string | undefined>;
    };
    "desktop_releases": {
      "currentDesktopRelease": FunctionReference<'query', 'public', { platform: string; }, any, string | undefined>;
    };
    "emoji_pack_generation": {
      "generatePack": FunctionReference<'action', 'public', { visibility: 'public' | 'unlisted' | 'private'; prompt: string; }, any, string | undefined>;
    };
    "emoji_pack_grid": {
      "getManifest": FunctionReference<'query', 'public', {}, any, string | undefined>;
    };
    "emoji_packs": {
      "listPublicPage": FunctionReference<'query', 'public', { search?: string | undefined; sort?: 'name' | 'installs' | undefined; tag?: string | undefined; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "listTagFacets": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "listMine": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getByPackId": FunctionReference<'query', 'public', { packId: string; }, any, string | undefined>;
      "setVisibility": FunctionReference<'mutation', 'public', { visibility: 'public' | 'unlisted' | 'private'; packId: string; }, any, string | undefined>;
      "deletePack": FunctionReference<'mutation', 'public', { packId: string; }, any, string | undefined>;
      "recordInstall": FunctionReference<'mutation', 'public', { packId: string; }, any, string | undefined>;
    };
    "fashion": {
      "getFashionFeatureStatus": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getProfile": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "setProfile": FunctionReference<'mutation', 'public', { displayName?: string | undefined; gender?: string | undefined; sizes?: Record<string, string> | undefined; stylePreferences?: string | undefined; }, any, string | undefined>;
      "setBodyPhotoFlag": FunctionReference<'mutation', 'public', { bodyPhotoMimeType?: string | undefined; hasBodyPhoto: boolean; }, any, string | undefined>;
      "listOutfits": FunctionReference<'query', 'public', { limit?: number | undefined; }, any, string | undefined>;
      "listOutfitsByBatch": FunctionReference<'query', 'public', { batchId: string; }, any, string | undefined>;
      "deleteOutfit": FunctionReference<'mutation', 'public', { outfitId: Id<'fashion_outfits'>; }, any, string | undefined>;
      "listLikes": FunctionReference<'query', 'public', { limit?: number | undefined; }, any, string | undefined>;
      "toggleLike": FunctionReference<'mutation', 'public', { currency?: string | undefined; imageUrl?: string | undefined; productUrl?: string | undefined; vendor?: string | undefined; priceCents?: number | undefined; title: string; productId: string; variantId: string; merchantOrigin: string; }, any, string | undefined>;
      "listCart": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "addToCart": FunctionReference<'mutation', 'public', { quantity?: number | undefined; currency?: string | undefined; imageUrl?: string | undefined; productUrl?: string | undefined; checkoutUrl?: string | undefined; vendor?: string | undefined; priceCents?: number | undefined; title: string; productId: string; variantId: string; merchantOrigin: string; }, any, string | undefined>;
      "removeFromCart": FunctionReference<'mutation', 'public', { cartItemId: Id<'fashion_cart_items'>; }, any, string | undefined>;
      "setCartQuantity": FunctionReference<'mutation', 'public', { quantity: number; cartItemId: Id<'fashion_cart_items'>; }, any, string | undefined>;
    };
    "integrations": {
      "createSlackInstallUrl": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
    };
    "pets": {
      "listPublicPage": FunctionReference<'query', 'public', { search?: string | undefined; tag?: string | undefined; sort: 'name' | 'downloads'; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "getByPetId": FunctionReference<'query', 'public', { id: string; }, any, string | undefined>;
      "getByPetIds": FunctionReference<'query', 'public', { ids: string[]; }, any, string | undefined>;
      "listTagFacets": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "incrementDownloads": FunctionReference<'mutation', 'public', { id: string; }, any, string | undefined>;
    };
    "preferences": {
      "getAccountMode": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "setAccountMode": FunctionReference<'mutation', 'public', { mode: 'private_local' | 'connected'; }, any, string | undefined>;
      "getSyncMode": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "setSyncMode": FunctionReference<'mutation', 'public', { mode: 'on' | 'off'; }, any, string | undefined>;
      "setPreferredBrowser": FunctionReference<'mutation', 'public', { browser: 'none' | 'arc' | 'brave' | 'chrome' | 'edge' | 'firefox' | 'opera' | 'safari' | 'vivaldi'; }, any, string | undefined>;
      "setExpressionStyle": FunctionReference<'mutation', 'public', { style: 'emoji' | 'none'; }, any, string | undefined>;
      "getLocale": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "setLocale": FunctionReference<'mutation', 'public', { locale: 'id' | 'en' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'nl' | 'ru' | 'ja' | 'zh-Hans' | 'zh-Hant' | 'ko' | 'pl' | 'sv' | 'nb' | 'da' | 'fi' | 'cs' | 'el' | 'tr' | 'ro' | 'hu' | 'ar' | 'hi' | 'vi' | 'th' | 'he'; }, any, string | undefined>;
    };
    "secrets": {
      "createSecret": FunctionReference<'mutation', 'public', { metadata?: Value | undefined; provider: string; label: string; plaintext: string; }, any, string | undefined>;
      "listSecrets": FunctionReference<'query', 'public', { provider?: string | undefined; }, any, string | undefined>;
      "deleteSecret": FunctionReference<'mutation', 'public', { secretId: Id<'secrets'>; }, any, string | undefined>;
    };
    "store_packages": {
      "listPackages": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "listPublicPackages": FunctionReference<'query', 'public', { category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "getPublicPackage": FunctionReference<'query', 'public', { packageId: string; }, any, string | undefined>;
      "getPublicPackagesByIds": FunctionReference<'query', 'public', { packageIds: string[]; }, any, string | undefined>;
      "listPublicReleases": FunctionReference<'query', 'public', { packageId: string; }, any, string | undefined>;
      "getPublicRelease": FunctionReference<'query', 'public', { packageId: string; releaseNumber: number; }, any, string | undefined>;
      "searchPublicPackages": FunctionReference<'query', 'public', { category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; query: string; }, any, string | undefined>;
      "listPackagesByAuthorUsername": FunctionReference<'query', 'public', { username: string; }, any, string | undefined>;
      "listMyPackages": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "setPackageVisibility": FunctionReference<'mutation', 'public', { packageId: string; visibility: 'public' | 'unlisted' | 'private'; }, any, string | undefined>;
      "deletePackage": FunctionReference<'mutation', 'public', { packageId: string; }, any, string | undefined>;
      "getPackage": FunctionReference<'query', 'public', { packageId: string; }, any, string | undefined>;
      "listReleases": FunctionReference<'query', 'public', { packageId: string; }, any, string | undefined>;
      "getRelease": FunctionReference<'query', 'public', { packageId: string; releaseNumber: number; }, any, string | undefined>;
      "recordPackageInstall": FunctionReference<'mutation', 'public', { packageId: string; }, any, string | undefined>;
      "createFirstRelease": FunctionReference<'action', 'public', { category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; iconUrl?: string | undefined; releaseNotes?: string | undefined; commits?: { hash: string; subject: string; diff: string; }[] | undefined; description: string; displayName: string; packageId: string; manifest: { summary?: string | undefined; category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; iconUrl?: string | undefined; authoredAtCommit?: string | undefined; }; blueprintMarkdown: string; }, any, string | undefined>;
      "createUpdateRelease": FunctionReference<'action', 'public', { iconUrl?: string | undefined; releaseNotes?: string | undefined; commits?: { hash: string; subject: string; diff: string; }[] | undefined; packageId: string; manifest: { summary?: string | undefined; category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; iconUrl?: string | undefined; authoredAtCommit?: string | undefined; }; blueprintMarkdown: string; }, any, string | undefined>;
    };
    "threads": {
      "loadThreadMessagesForRuntime": FunctionReference<'query', 'public', { threadId: Id<'threads'>; }, any, string | undefined>;
      "applyCompactionForRuntime": FunctionReference<'mutation', 'public', { threadId: Id<'threads'>; summary: string; keepFromOrdinal: number; }, any, string | undefined>;
    };
    "user_pet_uploads": {
      "createUploadUrl": FunctionReference<'action', 'public', { contentType?: string | undefined; previewSha256?: string | undefined; petId: string; spritesheetSha256: string; }, any, string | undefined>;
    };
    "user_pets": {
      "listPublicPage": FunctionReference<'query', 'public', { search?: string | undefined; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "listMine": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getByPetId": FunctionReference<'query', 'public', { petId: string; }, any, string | undefined>;
      "createPet": FunctionReference<'mutation', 'public', { prompt?: string | undefined; previewUrl?: string | undefined; description: string; displayName: string; visibility: 'public' | 'unlisted' | 'private'; spritesheetUrl: string; petId: string; }, any, string | undefined>;
      "setVisibility": FunctionReference<'mutation', 'public', { visibility: 'public' | 'unlisted' | 'private'; petId: string; }, any, string | undefined>;
      "deletePet": FunctionReference<'mutation', 'public', { petId: string; }, any, string | undefined>;
      "recordInstall": FunctionReference<'mutation', 'public', { petId: string; }, any, string | undefined>;
    };
  };
  "events": {
    "appendEvent": FunctionReference<'mutation', 'public', { channelEnvelope?: { attachments?: { id?: string | undefined; name?: string | undefined; mimeType?: string | undefined; url?: string | undefined; size?: number | undefined; kind?: string | undefined; providerMeta?: Value | undefined; }[] | undefined; chatType?: string | undefined; externalUserId?: string | undefined; externalChatId?: string | undefined; externalMessageId?: string | undefined; threadId?: string | undefined; text?: string | undefined; reactions?: { targetMessageId?: string | undefined; emoji: string; action: 'add' | 'remove'; }[] | undefined; sourceTimestamp?: number | undefined; providerPayload?: Value | undefined; provider: string; kind: 'message' | 'reaction' | 'edit' | 'delete' | 'system'; } | undefined; deviceId?: string | undefined; timestamp?: number | undefined; requestId?: string | undefined; targetDeviceId?: string | undefined; type: 'user_message' | 'assistant_message' | 'agent-started' | 'agent-completed' | 'agent-failed' | 'agent-canceled' | 'agent-progress' | 'tool_request' | 'tool_result' | 'microcompact_boundary' | 'remote_turn_request' | 'screen_event'; conversationId: Id<'conversations'>; payload: Value; }, any, string | undefined>;
    "importLocalMessagesChunk": FunctionReference<'mutation', 'public', { messages: { deviceId?: string | undefined; text: string; timestamp: number; role: 'user' | 'assistant'; localMessageId: string; }[]; conversationId: Id<'conversations'>; }, any, string | undefined>;
    "listEvents": FunctionReference<'query', 'public', { conversationId: Id<'conversations'>; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
    "subscribeRemoteTurnRequestsForDevice": FunctionReference<'query', 'public', { limit?: number | undefined; deviceId: string; since: number; }, any, string | undefined>;
    "isRemoteTurnClaimed": FunctionReference<'query', 'public', { requestId: string; }, any, string | undefined>;
  };
  "feedback": {
    "submitFeedback": FunctionReference<'mutation', 'public', { platform?: string | undefined; appVersion?: string | undefined; message: string; }, any, string | undefined>;
  };
  "media_jobs": {
    "getByJobId": FunctionReference<'query', 'public', { jobId: string; }, any, string | undefined>;
    "listSucceededSince": FunctionReference<'query', 'public', { limit?: number | undefined; includeLogs?: boolean | undefined; since: number; }, any, string | undefined>;
  };
  "mobile_access": {
    "getPhoneAccessState": FunctionReference<'query', 'public', { desktopDeviceId: string; }, any, string | undefined>;
    "createPairingSession": FunctionReference<'mutation', 'public', { desktopDeviceId: string; }, any, string | undefined>;
    "revokePairedMobileDevice": FunctionReference<'mutation', 'public', { desktopDeviceId: string; mobileDeviceId: string; }, any, string | undefined>;
    "watchIncomingConnectIntent": FunctionReference<'query', 'public', { desktopDeviceId: string; nowMs: number; }, any, string | undefined>;
    "acknowledgeConnectIntent": FunctionReference<'mutation', 'public', { intentId: Id<'mobile_connect_intents'>; }, any, string | undefined>;
  };
  "r2_files": {
    "generateUploadUrl": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
    "syncMetadata": FunctionReference<'mutation', 'public', { key: string; }, any, string | undefined>;
  };
  "reset": {
    "resetAllUserData": FunctionReference<'action', 'public', {}, any, string | undefined>;
  };
  "scheduling": {
    "cron_jobs": {
      "completeCronTurnResult": FunctionReference<'mutation', 'public', { conversationId: Id<'conversations'>; text: string; requestId: string; }, any, string | undefined>;
    };
  };
  "social": {
    "messages": {
      "listRoomMessages": FunctionReference<'query', 'public', { roomId: Id<'social_rooms'>; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "sendRoomMessage": FunctionReference<'mutation', 'public', { clientMessageId?: string | undefined; roomId: Id<'social_rooms'>; body: string; }, any, string | undefined>;
    };
    "profiles": {
      "ensureProfile": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
      "getMyProfile": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getProfileByUsername": FunctionReference<'query', 'public', { username: string; }, any, string | undefined>;
      "claimUsername": FunctionReference<'mutation', 'public', { username: string; }, any, string | undefined>;
      "getProfilesByOwnerIds": FunctionReference<'query', 'public', { ownerIds: string[]; }, any, string | undefined>;
      "updateMyAvatar": FunctionReference<'mutation', 'public', { avatarUrl: string | null; }, any, string | undefined>;
    };
    "relationships": {
      "listFriends": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "listPendingRequests": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getUnseenIncomingFriendRequestCount": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "markIncomingFriendRequestsSeen": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
      "sendFriendRequest": FunctionReference<'mutation', 'public', { username: string; }, any, string | undefined>;
      "respondToFriendRequest": FunctionReference<'mutation', 'public', { action: 'accept' | 'decline' | 'block'; requesterOwnerId: string; }, any, string | undefined>;
      "removeFriend": FunctionReference<'mutation', 'public', { otherOwnerId: string; }, any, string | undefined>;
    };
    "rooms": {
      "listRooms": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getGlobalRoomSummary": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getOrJoinGlobalRoom": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
      "getRoom": FunctionReference<'query', 'public', { roomId: Id<'social_rooms'>; }, any, string | undefined>;
      "getOrCreateDmRoom": FunctionReference<'mutation', 'public', { otherOwnerId: string; }, any, string | undefined>;
      "createGroupRoom": FunctionReference<'mutation', 'public', { title: string; memberOwnerIds: string[]; }, any, string | undefined>;
      "addGroupMembers": FunctionReference<'mutation', 'public', { roomId: Id<'social_rooms'>; memberOwnerIds: string[]; }, any, string | undefined>;
      "markRoomRead": FunctionReference<'mutation', 'public', { messageId?: Id<'social_messages'> | undefined; roomId: Id<'social_rooms'>; }, any, string | undefined>;
    };
    "sessions": {
      "listSessions": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getSession": FunctionReference<'query', 'public', { sessionId: Id<'stella_sessions'>; }, any, string | undefined>;
      "createSession": FunctionReference<'mutation', 'public', { workspaceFolderName?: string | undefined; roomId: Id<'social_rooms'>; hostDeviceId: string; workspaceSlug: string; }, any, string | undefined>;
      "updateSessionStatus": FunctionReference<'mutation', 'public', { status: 'active' | 'paused' | 'ended'; sessionId: Id<'stella_sessions'>; }, any, string | undefined>;
      "listTurns": FunctionReference<'query', 'public', { sessionId: Id<'stella_sessions'>; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "queueTurn": FunctionReference<'mutation', 'public', { agentType?: string | undefined; clientTurnId?: string | undefined; prompt: string; sessionId: Id<'stella_sessions'>; }, any, string | undefined>;
      "listPendingTurnsForHostDevice": FunctionReference<'query', 'public', { deviceId: string; }, any, string | undefined>;
      "claimTurn": FunctionReference<'mutation', 'public', { deviceId: string; sessionId: Id<'stella_sessions'>; turnId: Id<'stella_session_turns'>; }, any, string | undefined>;
      "completeTurn": FunctionReference<'mutation', 'public', { deviceId: string; sessionId: Id<'stella_sessions'>; resultText: string; turnId: Id<'stella_session_turns'>; }, any, string | undefined>;
      "failTurn": FunctionReference<'mutation', 'public', { deviceId: string; error: string; sessionId: Id<'stella_sessions'>; turnId: Id<'stella_session_turns'>; }, any, string | undefined>;
      "releaseTurn": FunctionReference<'mutation', 'public', { deviceId: string; sessionId: Id<'stella_sessions'>; turnId: Id<'stella_session_turns'>; }, any, string | undefined>;
      "listWorkspaceFiles": FunctionReference<'query', 'public', { cursor?: string | null | undefined; includeDownloadUrls?: boolean | undefined; sessionId: Id<'stella_sessions'>; }, any, string | undefined>;
      "markFileOpsApplied": FunctionReference<'mutation', 'public', { sessionId: Id<'stella_sessions'>; lastAppliedFileOpOrdinal: number; }, any, string | undefined>;
      "createDirectory": FunctionReference<'mutation', 'public', { sessionId: Id<'stella_sessions'>; relativePath: string; }, any, string | undefined>;
      "listFileOps": FunctionReference<'query', 'public', { limit?: number | undefined; afterOrdinal?: number | undefined; sessionId: Id<'stella_sessions'>; }, any, string | undefined>;
      "markSnapshotCreated": FunctionReference<'mutation', 'public', { sessionId: Id<'stella_sessions'>; }, any, string | undefined>;
      "acknowledgeFileOps": FunctionReference<'mutation', 'public', { sessionId: Id<'stella_sessions'>; lastAppliedOrdinal: number; }, any, string | undefined>;
      "deleteFile": FunctionReference<'mutation', 'public', { sessionId: Id<'stella_sessions'>; relativePath: string; }, any, string | undefined>;
      "uploadFile": FunctionReference<'action', 'public', { contentType?: string | undefined; sessionId: Id<'stella_sessions'>; contentHash: string; relativePath: string; contentBase64: string; }, any, string | undefined>;
    };
  };
  "stella_models": {
    "getModelCatalogUpdatedAt": FunctionReference<'query', 'public', {}, any, string | undefined>;
  };
} & Record<string, any>;
