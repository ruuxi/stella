# Stella

Split-repo AI assistant: `desktop/` (Electron + React/Vite) and `backend/` (Convex serverless). No `.git` at root — each sub-repo has its own git repository. Desktop owns the PI agent runtime, local tool catalog, local first data, and all agent execution. Backend owns the llm calls and offline fallback orchestrator.

## Product Context

Stella is a personal AI assistant for non-technical users. Minimal setup for users to start. Agent system: orchestrator + subordinate agents, non-blocking. Chat, computer/browser use, completely customizable interface, and automations/scheduling.

**Audience rule**: Never expose code, developer terminology, or technical internals in end-user UX/copy unless explicitly requested.

## Important

- Greenfield project — No backwards compatibility, migrations, or legacy.
- Always provide the best solution, regardless of how much refactoring or rewriting is required.
- Consider multiple possible solutions, working step by step to derive on a recommendation
- Always handle both Windows and MacOS when implementing in the desktop app.

## Storage Note

Storage is split between local desktop and backend Convex — see each sub-repo's CLAUDE.md for details.

## Agent Usage

- When using the Task tool, always use `model: "opus"` for subagents
- Never use Haiku or Sonnet subagents

