# Agent Metadata

These files define local capabilities such as tools and maximum agent depth.
They intentionally contain no system-prompt bodies, except that `manager.md`
also carries a transitional bundled default for deployed prompt manifests that
predate the Manager agent. Prompt sync seeds it only when Manager is missing;
it is not registered directly by the runtime extension.

Canonical prompt bodies live in the sibling `stella-backend` repository under
`prompts/stella-runtime/` and are synchronized into `~/.stella/` at startup.
