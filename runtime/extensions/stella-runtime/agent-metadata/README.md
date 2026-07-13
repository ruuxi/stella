# Agent Metadata

These files define local capabilities such as tools and maximum agent depth.
Canonical full prompt bodies remain backend-owned. A metadata file may carry a
small additive runtime guidance fragment for a capability added here, and
`manager.md` temporarily carries the manager bootstrap prompt until the paired
backend prompt manifest adds that new agent.

Canonical prompt bodies live in the sibling `stella-backend` repository under
`prompts/stella-runtime/` and are synchronized into `~/.stella/` at startup.
