/**
 * Identity Map - Persistent Pseudonymization Layer
 *
 * Maps real contact names/identifiers to fake aliases so the LLM/backend
 * never sees real PII. The mapping persists at ~/.stella/state/identity_map.json.
 */
import type { IdentityMap, IdentityMappingSource } from "./discovery_types";
/**
 * Generate a deterministic alias from a real identifier
 */
export declare function generateAlias(realIdentifier: string): {
    name: string;
    identifier: string;
};
/**
 * Load the identity map from disk
 */
export declare function loadIdentityMap(stellaHome: string): Promise<IdentityMap>;
/**
 * Save the identity map to disk
 */
export declare function saveIdentityMap(stellaHome: string, map: IdentityMap): Promise<void>;
/**
 * Add contacts to the identity map (creates aliases for new contacts)
 */
export declare function addContacts(stellaHome: string, contacts: {
    name: string;
    identifier: string;
    source: IdentityMappingSource;
}[]): Promise<IdentityMap>;
/**
 * Replace real identifiers with aliases in text
 */
export declare function pseudonymize(text: string, map: IdentityMap): string;
/**
 * Replace aliases with real identifiers in text (reverse of pseudonymize)
 */
export declare function depseudonymize(text: string, map: IdentityMap): string;
