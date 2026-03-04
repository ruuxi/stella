# Stella: Self-Modification Architecture

## The Overall Idea of Stella

Stella is a personal AI assistant designed for non-technical users, focusing on zero or minimal setup. It operates on four core beliefs:
1. Control the computer
2. Use the browser
3. Provide a completely customizable interface
4. Enable automations and scheduling

Unlike traditional sealed desktop applications, Stella functions as a user-owned, self-modifying software platform. It is packaged fundamentally as a "live dev server" (using Electron + React/Vite for the frontend and Convex for the backend). This architectural choice gives Stella the ability to edit its own frontend code dynamically when requested, enabling infinite customization ranging from individual component tweaks to entirely generated custom applications. Stella operates the user's computer with the same practical access the user has, making it a highly trusted and capable agent.

## The Approach to Self-Modification

To achieve true extensibility without hardcoded plugin boundaries, Stella employs the **Headless Core + "Dumb Tree" Architecture** combined with **Dev-Server Level HMR Interception**.

### 1. Headless Core & "Dumb Tree"
All core business logic (WebSockets, IPC routing, LLM orchestration, streaming states) is protected within a unified headless provider (e.g., `<StellaCoreProvider>`). The entire presentation layer (layouts, sidebars, views) relies on this provider but remains fundamentally "dumb" and purely presentational.

The AI agent is given standard file system tools to read, write, and execute shell commands directly within the React frontend directory. It modifies standard React code and standard package imports, just like a human developer would.

### 2. Handling Intermediate Broken States (HMR Pause/Resume)
Because the AI takes multiple turns to edit files and install dependencies, an eager file watcher like Vite would normally crash the user's UI with incomplete syntax errors or forced reloads.

To solve this, Stella uses a **Vite HMR Interceptor**:
- When the self-modification agent begins a task, an IPC message tells Vite to **pause** HMR updates to the client.
- The active UI remains fully usable. The user sees a non-blocking indicator (e.g., "Stella is updating the UI...").
- The Vite server continues compiling the agent's work in the background, providing the agent with immediate error feedback.
- When the agent finishes all edits and package installations, HMR is **resumed**. The queued updates are flushed to the client. If a full reload is required (e.g., due to a new dependency), a loading state overlay masks the transition.

### 3. File Security and Access Control
Because the agent edits the actual files on disk, we restrict manual or third-party interference. File changes to the Stella frontend folder that do not originate from an active Stella agent turn are automatically denied. This is managed programmatically behind the scenes (e.g., via OS-level permissions or `chmod` toggling during agent turns) to prevent external corruption.

## Why We Took This Approach

1. **Alignment with LLM Training:** Large Language Models are extensively trained on standard React codebases, file-based routing, and conventional package management (npm/bun). By allowing the agent to edit a standard Vite project, we get maximum reliability compared to forcing it to use a proprietary AST-editor, proprietary plugin registry, or custom CDN injection strategies.
2. **True Infinite Freedom:** Hardcoded widgets or layout slots limit user customization. By abstracting the core logic away and letting the agent modify the entire DOM tree, the user can have a standard dashboard one minute and a retro 90s terminal the next.
3. **Simplicity Over "Shadow Workspaces":** Instead of building a complex virtual file system or shadow workspace where the agent works in an isolated bubble, we use the real file system. This allows standard dev tools (linters, compilers) to provide the agent with accurate feedback. By simply "pausing" the HMR websocket at the very end of the pipeline, we achieve the safety of a transactional update without the massive infrastructure overhead of duplicate file systems.
4. **Maintained UX:** The user never experiences frozen states, intermediate crashes, or disjointed partial updates. They get a continuous, non-blocking experience while the UI transforms smoothly.
