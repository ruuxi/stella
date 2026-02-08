/**
 * Feature lifecycle management.
 * Feature metadata stored at ~/.stella/mods/features/{featureId}/meta.json
 * Active feature tracking stored at ~/.stella/mods/active.json
 */
export type FeatureMeta = {
    id: string;
    name: string;
    description: string;
    conversationId: string;
    status: "active" | "applied" | "reverted" | "packaged";
    createdAt: number;
    updatedAt: number;
};
/**
 * Create a new feature with metadata.
 */
export declare function createFeature(id: string, name: string, description: string, conversationId: string): Promise<FeatureMeta>;
/**
 * Get feature metadata by ID.
 */
export declare function getFeature(featureId: string): Promise<FeatureMeta | null>;
/**
 * Update feature metadata.
 */
export declare function updateFeature(featureId: string, updates: Partial<FeatureMeta>): Promise<void>;
/**
 * Get active feature for a conversation.
 */
export declare function getActiveFeature(conversationId: string): Promise<string | null>;
/**
 * Set active feature for a conversation.
 */
export declare function setActiveFeature(conversationId: string, featureId: string): Promise<void>;
/**
 * List all features with their metadata.
 */
export declare function listFeatures(): Promise<FeatureMeta[]>;
