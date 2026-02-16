/**
 * Security hardening utilities for the local tool system.
 *
 * - isDangerousCommand(): blocklist of destructive shell commands
 * - isBlockedPath(): system directory path guard for file operations
 * - validateSkillContent(): scans skill markdown for unsafe patterns
 */
/**
 * Check if a command string contains dangerous/destructive patterns.
 * Returns `null` if safe, or a reason string if blocked.
 */
export declare const isDangerousCommand: (command: string) => string | null;
/**
 * Check if a file path targets a blocked system directory.
 * Returns `null` if allowed, or an error message if blocked.
 */
export declare const isBlockedPath: (filePath: string) => string | null;
export type SkillValidationResult = {
    safe: boolean;
    issues: Array<{
        category: string;
        description: string;
    }>;
};
/**
 * Validate skill markdown content for unsafe patterns.
 * Returns a result indicating whether the content is safe and what issues were found.
 */
export declare const validateSkillContent: (content: string) => SkillValidationResult;
