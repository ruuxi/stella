# Stella Frontend Extensibility & Customization Approaches

## Objective

Stella’s core principles state that it is a "live dev server" and favors "extensibility through AI modification over hardcoded extension boundaries." Stella operates as a user-owned, self-modifying software platform rather than a sealed binary application.

The goal is to determine the architectural approach for the frontend that best supports these principles. The frontend must achieve the feeling of a "personal website"—allowing the UI to be infinitely customized (from adding a single widget to fundamentally rewriting the layout and removing core elements like sidebars)—while ensuring that the AI agent can safely and predictably implement these changes without breaking Stella's underlying messaging, streaming, and execution engine.

This document outlines the spectrum of possible architectural approaches, ranging from highly structured and constrained to entirely freeform.

---

## Approach 1: The Component Registry (Widget-Based Extensibility)

*Similar to a traditional plugin architecture or dashboard system.*

Instead of hardcoding components (e.g., `<NewsFeed />`, `<GenerativeCanvas />`) into a view file, the application loops through a dynamic registry of "widgets" and renders them into predefined layout zones (like a CSS Grid or predefined sidebar slots).

**How it works:**
The agent creates a new React component in a specific folder (e.g., `src/views/home/widgets/WeatherWidget.tsx`). It then updates a `registry.ts` file or a manifest that dictates which widgets are active and what layout coordinates they occupy.

**Agent Ease of Use:** Very high. The agent gets a constrained, blank canvas (a single component) to work in. It does not need to parse and carefully modify massive layout files.
**Freedom:** Medium. The user gains custom functionality, but the overarching layout system, grid structure, padding, and core theme remain controlled by Stella.
**Management:** Easy to revert and isolate failures. If a widget breaks, Stella can catch the error at the React Error Boundary level and disable that specific widget without affecting the rest of the application.

---

## Approach 2: Pi-Style Event Hooks & DOM Injection

*Similar to Pi's UI augmentation (`ctx.ui.setWidget`, `ctx.ui.setFooter`).*

The frontend exposes specific "mount points" or listens for events when rendering. Extensibility is handled at runtime via events rather than modifying the core React source code directly.

**How it works:**
An agent or loaded skill (from `~/.stella/skills`) emits events to the frontend via IPC. For example, a "Spotify Skill" might send an IPC message: `ui.inject({ zone: "sidebar", componentPath: "skills/spotify/Player.tsx" })`. The frontend listens to these events and dynamically imports and mounts the components into the requested zones.

**Agent Ease of Use:** Medium-High. The agent writes independent skills that "declare" their UI, rather than having to manually parse and edit frontend source code ASTs.
**Freedom:** Medium-High. It allows skills to carry their own UI with them natively, but they are still restricted to injecting into predetermined zones defined by the frontend host.
**Management:** Excellent for sharing. A user can install a skill and get both the backend logic and the frontend UI automatically without touching the core codebase.

---

## Approach 3: The "Replaceable View" / Router-Level Customization

*Similar to overriding built-in tools or swapping themes at a macro level.*

Instead of making the default views modular, all complex logic (database queries, state management, event listeners) is abstracted into pure headless hooks (e.g., `useHomeData()`). 

**How it works:**
If a user wants a completely different layout, the agent does not edit the default view (e.g., `HomeView.tsx`). Instead, it creates `CustomHomeView.tsx`, utilizes the headless hooks to retrieve necessary data, and writes entirely new DOM/CSS from scratch. It then updates the application router to point the specific route to the new `CustomHomeView.tsx`.

**Agent Ease of Use:** Medium. The agent must write a full page from scratch, but it is shielded from breaking the original file and can confidently use the provided data hooks.
**Freedom:** Very High. The user can have a minimalist terminal view, a complex dashboard, or a literal personal website homepage.
**Management:** Safe. The original view is preserved as a fallback. If the custom view fails to compile, the agent can easily revert the router back to the default view.

---

## Approach 4: Headless Core + File-Based Routing (The "Dumb Tree" Architecture)

*Treating the application exactly like a standard React/Vite web project optimized for AI-driven Hot Module Replacement (HMR).*

This approach relies on extracting 100% of the core business logic (websockets, event tracking, IPC routing, streaming states) out of the presentation layer and into a unified headless provider (e.g., `<StellaCoreProvider>`). This provider exposes a single, globally available hook (e.g., `useStella()`). Consequently, the entire component tree (Layouts, Sidebars, Views) becomes "dumb" and purely presentational.

**How it works:**
The application utilizes a standard file-based routing paradigm (like React Router). Because the core logic is protected within the `useStella()` hook, the agent is granted full permission to directly edit, rewrite, or delete any presentation component or layout file.

**Examples in practice:**

*   **Scenario A: Add a weather widget to the sidebar.**
    The agent creates `src/components/widgets/Weather.tsx`. It then opens the dumb `src/components/Sidebar.tsx` file and directly adds `<Weather />` to the JSX. No plugin registries are needed.
*   **Scenario B: Create a new page for smart home controls.**
    The agent creates `src/pages/SmartHome.tsx` and uses `useStella()` to trigger any necessary agent commands. It updates `src/router.tsx` to add the `/smart-home` route, and edits `Sidebar.tsx` to add a navigation link.
*   **Scenario C: Total UI overhaul (e.g., a retro 90s terminal).**
    The agent changes the root `App.tsx` layout to point to a new `src/layouts/TerminalLayout.tsx` instead of the default layout. It builds the Terminal layout entirely from scratch, pulling in the `useStella()` hook to send/receive messages, discarding the sidebar and standard UI entirely.

**Agent Ease of Use:** High, specifically because LLMs are heavily trained on standard React Router and pure functional component patterns, rather than proprietary plugin architectures.
**Freedom:** Infinite. It is a raw React codebase the agent can modify without boundary restrictions.
**Management:** Relies entirely on the agent's ability to utilize standard web paradigms and the system's ability to catch compilation/React errors to trigger self-modification reverts on the dumb components.