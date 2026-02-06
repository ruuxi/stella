/**
 * Discovery Types & Category Configuration
 *
 * Defines the 4 onboarding-selectable discovery categories
 * and type definitions for all signal collectors.
 */
export const DISCOVERY_CATEGORIES = [
    {
        id: "browsing_bookmarks",
        label: "Browsing & Bookmarks",
        description: "Browser history, bookmarks, and saved pages",
        defaultEnabled: true,
        requiresFDA: false,
    },
    {
        id: "dev_environment",
        label: "Development Environment",
        description: "IDE extensions, git config, dotfiles, runtimes, and package managers",
        defaultEnabled: true,
        requiresFDA: false,
    },
    {
        id: "apps_system",
        label: "Apps & System",
        description: "App usage patterns, dock pins, and filesystem signals",
        defaultEnabled: true,
        requiresFDA: true,
    },
    {
        id: "messages_notes",
        label: "Messages & Notes",
        description: "Communication patterns, note titles, calendar density (metadata only)",
        defaultEnabled: false,
        requiresFDA: true,
    },
];
