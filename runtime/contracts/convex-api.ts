import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import type { Value } from "convex/values";

type Id<_TableName extends string> = string;

export const api: PublicApiType = anyApi as unknown as PublicApiType;

export type PublicApiType = {
  "agent": {
    "device_resolver": {
      "heartbeat": FunctionReference<'mutation', 'public', { deviceName?: string | undefined; platform?: string | undefined; deviceId: string; publicKey: string; signedAtMs: number; signature: string; }, any, string | undefined>;
      "registerDevice": FunctionReference<'mutation', 'public', { deviceName?: string | undefined; platform?: string | undefined; deviceId: string; }, any, string | undefined>;
      "goOffline": FunctionReference<'mutation', 'public', { deviceId: string; }, any, string | undefined>;
    };
    "local_runtime": {
      "executeTool": FunctionReference<'action', 'public', { conversationId?: Id<'conversations'> | undefined; agentType?: string | undefined; toolArgs?: Value | undefined; toolName: string; }, any, string | undefined>;
      "webSearch": FunctionReference<'action', 'public', { conversationId?: Id<'conversations'> | undefined; category?: string | undefined; agentType?: string | undefined; query: string; }, any, string | undefined>;
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
    "getAuthUser": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "getCurrentUser": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "revokeActiveSessions": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
  };
  "billing": {
    "getSubscriptionStatus": FunctionReference<'query', 'public', { now?: number | undefined; }, any, string | undefined>;
    "createCheckoutSession": FunctionReference<'action', 'public', { plan: 'go' | 'pro' | 'plus' | 'ultra' | 'max'; returnUrl: string; }, any, string | undefined>;
    "getUsageCreditPurchaseOptions": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "getUsageCreditStatus": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "createUsageCreditCheckoutSession": FunctionReference<'action', 'public', { amountCents: number; returnUrl: string; }, any, string | undefined>;
    "createBillingPortalSession": FunctionReference<'action', 'public', { returnUrl: string; }, any, string | undefined>;
    "getCurrentPlan": FunctionReference<'query', 'public', {}, any, string | undefined>;
  };
  "channels": {
    "connector_delivery": {
      "claimRemoteTurn": FunctionReference<'mutation', 'public', { deviceId?: string | undefined; conversationId: Id<'conversations'>; requestId: string; }, any, string | undefined>;
      "cancelRemoteTurn": FunctionReference<'mutation', 'public', { requestId: string; }, any, string | undefined>;
      "completeRemoteTurn": FunctionReference<'mutation', 'public', { deviceId?: string | undefined; conversationId: Id<'conversations'>; text: string; requestId: string; }, any, string | undefined>;
      "streamConnectorTurnUpdate": FunctionReference<'mutation', 'public', { conversationId: Id<'conversations'>; text: string; requestId: string; revision: number; }, any, string | undefined>;
      "sendConnectorFollowup": FunctionReference<'mutation', 'public', { deviceId?: string | undefined; conversationId: Id<'conversations'>; text: string; requestId: string; }, any, string | undefined>;
    };
    "link_codes": {
      "generateLinkCode": FunctionReference<'mutation', 'public', { provider: string; }, any, string | undefined>;
      "verifyLinqLinkCode": FunctionReference<'mutation', 'public', { code: string; phoneNumber: string; }, any, string | undefined>;
    };
    "linq": {
      "executeLinqConnectorTool": FunctionReference<'action', 'public', { conversationId: Id<'conversations'>; payload: Value; requestId: string; operation: string; }, any, string | undefined>;
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
    "emoji_pack_uploads": {
      "createUploadUrl": FunctionReference<'action', 'public', { contentType?: string | undefined; packId: string; sheetSha256s: string[]; }, any, string | undefined>;
    };
    "emoji_packs": {
      "listPublicPage": FunctionReference<'query', 'public', { search?: string | undefined; sort?: 'name' | 'installs' | undefined; tag?: string | undefined; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "listTagFacets": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "listMine": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getByPackId": FunctionReference<'query', 'public', { packId: string; }, any, string | undefined>;
      "createPack": FunctionReference<'mutation', 'public', { description?: string | undefined; prompt?: string | undefined; coverUrl?: string | undefined; displayName: string; visibility: 'public' | 'unlisted' | 'private'; packId: string; coverEmoji: string; sheetUrls: string[]; }, any, string | undefined>;
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
      "addToCart": FunctionReference<'mutation', 'public', { currency?: string | undefined; quantity?: number | undefined; imageUrl?: string | undefined; productUrl?: string | undefined; checkoutUrl?: string | undefined; vendor?: string | undefined; priceCents?: number | undefined; title: string; productId: string; variantId: string; merchantOrigin: string; }, any, string | undefined>;
      "removeFromCart": FunctionReference<'mutation', 'public', { cartItemId: Id<'fashion_cart_items'>; }, any, string | undefined>;
      "setCartQuantity": FunctionReference<'mutation', 'public', { quantity: number; cartItemId: Id<'fashion_cart_items'>; }, any, string | undefined>;
    };
    "integrations": {
      "listStoreIntegrations": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "createSlackInstallUrl": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
      "createXConnectUrl": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
      "listXConnections": FunctionReference<'query', 'public', {}, any, string | undefined>;
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
      "getLocale": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "setLocale": FunctionReference<'mutation', 'public', { locale: 'id' | 'en' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'nl' | 'ru' | 'ja' | 'zh-Hans' | 'zh-Hant' | 'ko' | 'pl' | 'sv' | 'nb' | 'da' | 'fi' | 'cs' | 'el' | 'tr' | 'ro' | 'hu' | 'ar' | 'hi' | 'vi' | 'th' | 'he'; }, any, string | undefined>;
    };
    "secrets": {
      "createSecret": FunctionReference<'mutation', 'public', { metadata?: Value | undefined; provider: string; label: string; plaintext: string; }, any, string | undefined>;
      "listSecrets": FunctionReference<'query', 'public', { provider?: string | undefined; }, any, string | undefined>;
      "deleteSecret": FunctionReference<'mutation', 'public', { secretId: Id<'secrets'>; }, any, string | undefined>;
    };
    "store_admin": {
      "isStoreAdmin": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "listPendingSubmissions": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "approveSubmission": FunctionReference<'mutation', 'public', { releaseId: Id<'store_package_releases'>; }, any, string | undefined>;
      "rejectSubmission": FunctionReference<'mutation', 'public', { reason?: string | undefined; releaseId: Id<'store_package_releases'>; }, any, string | undefined>;
    };
    "store_git_artifacts": {
      "prepareGitObjectUploads": FunctionReference<'action', 'public', { objects: { type: 'blob' | 'tree' | 'commit'; sizeBytes: number; sha: string; }[]; }, any, string | undefined>;
      "verifyGitObjectUploads": FunctionReference<'action', 'public', { objects: { type: 'blob' | 'tree' | 'commit'; sizeBytes: number; sha: string; }[]; }, any, string | undefined>;
      "prepareDiffUpload": FunctionReference<'action', 'public', { packageId: string; sha256: string; sizeBytes: number; }, any, string | undefined>;
      "getReleaseDiff": FunctionReference<'action', 'public', { packageId: string; releaseNumber: number; }, any, string | undefined>;
      "getReleaseCommits": FunctionReference<'action', 'public', { packageId: string; releaseNumber: number; }, any, string | undefined>;
      "getReleaseGitObjectUrls": FunctionReference<'action', 'public', { packageId: string; releaseNumber: number; shas: string[]; }, any, string | undefined>;
    };
    "store_packages": {
      "listPackages": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "listPublicPackages": FunctionReference<'query', 'public', { category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "listNewPublicPackages": FunctionReference<'query', 'public', { limit?: number | undefined; }, any, string | undefined>;
      "listPromotedPublicPackages": FunctionReference<'query', 'public', { limit?: number | undefined; nowMs: number; }, any, string | undefined>;
      "getPublicPackage": FunctionReference<'query', 'public', { packageId: string; }, any, string | undefined>;
      "getPublicPackagesByIds": FunctionReference<'query', 'public', { packageIds: string[]; }, any, string | undefined>;
      "listPublicReleases": FunctionReference<'query', 'public', { packageId: string; }, any, string | undefined>;
      "getPublicRelease": FunctionReference<'query', 'public', { packageId: string; releaseNumber: number; }, any, string | undefined>;
      "searchPublicPackages": FunctionReference<'query', 'public', { category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; query: string; }, any, string | undefined>;
      "listPackagesByAuthorUsername": FunctionReference<'query', 'public', { username: string; }, any, string | undefined>;
      "listMyPackages": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "setPackageVisibility": FunctionReference<'mutation', 'public', { packageId: string; visibility: 'public' | 'unlisted' | 'private'; }, any, string | undefined>;
      "listMySubmissions": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "deletePackage": FunctionReference<'mutation', 'public', { packageId: string; }, any, string | undefined>;
      "getPackage": FunctionReference<'query', 'public', { packageId: string; }, any, string | undefined>;
      "listReleases": FunctionReference<'query', 'public', { packageId: string; }, any, string | undefined>;
      "getRelease": FunctionReference<'query', 'public', { packageId: string; releaseNumber: number; }, any, string | undefined>;
      "recordPackageInstall": FunctionReference<'mutation', 'public', { packageId: string; }, any, string | undefined>;
      "createFirstRelease": FunctionReference<'action', 'public', { description?: string | undefined; category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; iconUrl?: string | undefined; releaseNotes?: string | undefined; commits?: { hash: string; subject: string; }[] | undefined; commitsDiffRef?: { kind: 'r2'; r2Key: string; sha256: string; sizeBytes: number; } | undefined; gitArtifact?: { security?: { redactedPaths: string[]; omittedPaths: string[]; warnings: string[]; } | undefined; kind: 'git-object-artifact'; schemaVersion: 1; baseCommit: string; featureCommit: string; objects: { type: 'blob' | 'tree' | 'commit'; sizeBytes: number; sha: string; }[]; } | undefined; diffRef?: { kind: 'r2'; r2Key: string; sha256: string; sizeBytes: number; } | undefined; audience?: 'store' | 'circle' | undefined; displayName: string; packageId: string; manifest: { summary?: string | undefined; category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; iconUrl?: string | undefined; authoredAtCommit?: string | undefined; }; blueprintMarkdown: string; }, any, string | undefined>;
      "createUpdateRelease": FunctionReference<'action', 'public', { iconUrl?: string | undefined; releaseNotes?: string | undefined; commits?: { hash: string; subject: string; }[] | undefined; commitsDiffRef?: { kind: 'r2'; r2Key: string; sha256: string; sizeBytes: number; } | undefined; gitArtifact?: { security?: { redactedPaths: string[]; omittedPaths: string[]; warnings: string[]; } | undefined; kind: 'git-object-artifact'; schemaVersion: 1; baseCommit: string; featureCommit: string; objects: { type: 'blob' | 'tree' | 'commit'; sizeBytes: number; sha: string; }[]; } | undefined; diffRef?: { kind: 'r2'; r2Key: string; sha256: string; sizeBytes: number; } | undefined; audience?: 'store' | 'circle' | undefined; packageId: string; manifest: { summary?: string | undefined; category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; iconUrl?: string | undefined; authoredAtCommit?: string | undefined; }; blueprintMarkdown: string; }, any, string | undefined>;
    };
    "user_pet_generation": {
      "generatePet": FunctionReference<'action', 'public', { visibility: 'public' | 'unlisted' | 'private'; prompt: string; }, any, string | undefined>;
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
    "subscribeRemoteTurnRequestsForDevice": FunctionReference<'query', 'public', { limit?: number | undefined; deviceId: string; since: number; }, any, string | undefined>;
    "subscribeRemoteTurnCancelsForDevice": FunctionReference<'query', 'public', { limit?: number | undefined; deviceId: string; since: number; }, any, string | undefined>;
    "isRemoteTurnClaimed": FunctionReference<'query', 'public', { requestId: string; }, any, string | undefined>;
  };
  "feedback": {
    "submitFeedback": FunctionReference<'mutation', 'public', { platform?: string | undefined; appVersion?: string | undefined; message: string; }, any, string | undefined>;
  };
  "media_jobs": {
    "getByJobId": FunctionReference<'query', 'public', { jobId: string; }, any, string | undefined>;
    "listSucceededSince": FunctionReference<'query', 'public', { limit?: number | undefined; includeLogs?: boolean | undefined; since: number; }, any, string | undefined>;
    "listFailedSince": FunctionReference<'query', 'public', { limit?: number | undefined; includeLogs?: boolean | undefined; since: number; }, any, string | undefined>;
  };
  "mobile_access": {
    "getPhoneAccessState": FunctionReference<'query', 'public', { desktopDeviceId: string; }, any, string | undefined>;
    "createPairingSession": FunctionReference<'mutation', 'public', { desktopDeviceId: string; }, any, string | undefined>;
    "revokePairedMobileDevice": FunctionReference<'mutation', 'public', { desktopDeviceId: string; mobileDeviceId: string; }, any, string | undefined>;
    "watchIncomingConnectIntent": FunctionReference<'query', 'public', { desktopDeviceId: string; nowMs: number; }, any, string | undefined>;
    "acknowledgeConnectIntent": FunctionReference<'mutation', 'public', { intentId: Id<'mobile_connect_intents'>; }, any, string | undefined>;
  };
  "mobile_chat": {
    "sendChat": FunctionReference<'action', 'public', { model?: string | undefined; message: string; desktopDeviceId: string; mobileDeviceId: string; pairSecret: string; }, any, string | undefined>;
    "cancelChat": FunctionReference<'action', 'public', { requestId: string; desktopDeviceId: string; mobileDeviceId: string; pairSecret: string; }, any, string | undefined>;
  };
  "mobile_push": {
    "sendActivityNotification": FunctionReference<'action', 'public', { kind: 'completed' | 'failed' | 'started'; }, any, string | undefined>;
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
    "communities": {
      "getCommunityPreviewByInviteCode": FunctionReference<'query', 'public', { inviteCode: string; }, any, string | undefined>;
      "createCommunity": FunctionReference<'mutation', 'public', { name: string; }, any, string | undefined>;
      "joinCommunity": FunctionReference<'mutation', 'public', { inviteCode: string; }, any, string | undefined>;
      "renameCommunity": FunctionReference<'mutation', 'public', { name: string; roomId: Id<'social_rooms'>; }, any, string | undefined>;
      "removeCommunityMember": FunctionReference<'mutation', 'public', { roomId: Id<'social_rooms'>; memberOwnerId: string; }, any, string | undefined>;
      "leaveCommunity": FunctionReference<'mutation', 'public', { roomId: Id<'social_rooms'>; }, any, string | undefined>;
      "deleteCommunity": FunctionReference<'mutation', 'public', { roomId: Id<'social_rooms'>; }, any, string | undefined>;
    };
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
      "queueTurn": FunctionReference<'mutation', 'public', { agentType?: string | undefined; clientTurnId?: string | undefined; sessionId: Id<'stella_sessions'>; prompt: string; }, any, string | undefined>;
      "listPendingTurnsForHostDevice": FunctionReference<'query', 'public', { deviceId: string; }, any, string | undefined>;
      "claimTurn": FunctionReference<'mutation', 'public', { deviceId: string; sessionId: Id<'stella_sessions'>; turnId: Id<'stella_session_turns'>; }, any, string | undefined>;
      "completeTurn": FunctionReference<'mutation', 'public', { deviceId: string; sessionId: Id<'stella_sessions'>; resultText: string; turnId: Id<'stella_session_turns'>; }, any, string | undefined>;
      "failTurn": FunctionReference<'mutation', 'public', { deviceId: string; sessionId: Id<'stella_sessions'>; error: string; turnId: Id<'stella_session_turns'>; }, any, string | undefined>;
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
