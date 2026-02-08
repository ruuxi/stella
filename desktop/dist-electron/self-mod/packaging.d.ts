/**
 * Blueprint packaging for self-mod features.
 *
 * Blueprints are reference code + description that another AI can use
 * to re-implement a feature fresh for their specific codebase state.
 */
export type BlueprintFile = {
    path: string;
    action: "modify" | "create";
    content: string;
    originalHash?: string;
};
export type Blueprint = {
    format: "stella-blueprint-v1";
    name: string;
    description: string;
    implementation: string;
    version: string;
    author?: {
        id: string;
        name: string;
    };
    featureId: string;
    referenceFiles: BlueprintFile[];
    createdAt: number;
};
/**
 * Package a feature into a blueprint.
 * Collects all files from the feature's history and reads their current content.
 * The description and implementation fields are empty — the self-mod agent fills them in.
 */
export declare function packageFeature(featureId: string, frontendRoot: string): Promise<Blueprint | null>;
