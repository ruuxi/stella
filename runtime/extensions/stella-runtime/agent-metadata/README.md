# Agent Metadata

These files define local capabilities such as tools and maximum agent depth.
They use the established agent markdown shape: frontmatter followed by a
non-empty body. Capability-only entries use a short HTML comment as that body.

`maxAgentDepth` caps how deep a spawn chain may go, and the effective limit is
the minimum of the agent's own declared value and the one inherited from its
parent. Orchestrator and General both declare `2`, which permits
Orchestrator -> General -> subagent and blocks anything deeper.

Canonical prompt bodies live in the sibling `stella-backend` repository under
`prompts/stella-runtime/` and are synchronized into `~/.stella/` at startup.
