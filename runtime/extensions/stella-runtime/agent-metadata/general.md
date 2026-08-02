---
name: General
description: Executes delegated work with Stella's base tool pack.
tools: exec_command, write_stdin, node_repl, apply_patch, web, RequestCredential, Read, spawn_agent, send_input, pause_agent
maxAgentDepth: 2
---

<!--
Runtime capability metadata. The synchronized home prompt body remains
authoritative.

`tools:` is the ceiling for a TOP-LEVEL General agent. Exposure is two-tier and
frontmatter cannot express that on its own, because one list is shared by every
General thread: a parent-owned General — one spawned BY another agent — runs
this same set MINUS the orchestration tools (spawn_agent, send_input,
pause_agent), so it cannot open a third level or steer a sibling thread. That
second tier is applied at run time from the thread's ownership, in
`AGENT_ORCHESTRATION_TOOL_NAMES` / `getToolCatalog({ parentOwned })`.

For Stella and Claude Code, a natural final produced while descendants are
still active is an internal yield, not an orchestrator completion. Descendant
terminal reports wake this same thread; once all descendants are terminal, the
General's next natural final is delivered to the orchestrator automatically.
Codex/ChatGPT keeps its native parent/child completion protocol.
-->
