# Stella Source Control

Stella needs source control that behaves like GitHub for users without making them understand GitHub. The local install remains the source of truth. Convex and R2 only receive a package when a user shares or publishes a change.

## Current Shape

- Self-mod runs already commit local source changes and the inline undo flow reverts those commits.
- Store publishing ships a behavior spec, redacted per-commit reference diffs, and a Stella source pack when the selected commits are safe to package. When local Stella source-history rows exist, the pack preserves those revision ids and hydrates only the selected changed-file content for sharing.
- Store installation is always agent-applied. The behavior spec, redacted commit diffs, and source pack are materialized into a temporary install folder; the agent reads those exact package inputs and adapts the feature to the user's divergent tree. Installed packages record both local undo commits and Stella source revision ids, so updates can pass only the revisions since the user's installed version.
- Desktop releases publish an official source pack next to the hydrated platform archive. Clean source-pack updates apply locally without fetching Git objects, then native helpers check the latest helper manifest and no-op when already current. Conflict updates hand structured conflict content to the install-update agent.

That works, but it makes Git the product model. The better Stella model is a local history graph plus content-addressed source packs that can be merged directly when safe and handed to an agent only when there is a real semantic conflict.

## Target Model

### Local History

Every installed Stella carries the same base history ids for official releases. Those ids are hashes of file paths and blob hashes, not a clone of another user's full source tree. A release payload can hydrate the working tree while the history graph proves what base the user started from.

Each self-mod run appends a local revision:

- `revisionId`: hash of parent ids, feature id, description, paths, base hashes, and next hashes.
- `parentRevisionIds`: official release parent plus any feature/package parents.
- `featureId`: stable group id produced by Stella for a user-visible feature.
- `changes`: per-path base hash, next hash, and optional next content.

The local graph is private. It can diverge forever without syncing anywhere.

### Share Packs

When a user shares a Store package, Stella uploads only the selected feature revisions:

- Convex stores package metadata, release ordering, author, visibility, install counts, and moderation/review state.
- R2 stores larger source packs by content hash when the pack outgrows Convex document limits.
- A source pack contains changed-file content only for the shared feature. It does not contain unrelated files from the user's Stella.
- The behavior spec remains the semantic north star and review surface. The source pack is exact changed-file package material for the install agent, not a hidden clean-merge path for Store packages.

### Merge

Official desktop update uses the source merge primitive directly when clean. Store install/update uses the same source-pack shape as agent input, but the agent always performs the local implementation:

1. Confirm the install has the referenced base history id.
2. For each changed path, compare the user's local blob hash to the pack's base and next hashes.
3. If local equals base, write the incoming blob.
4. If local equals next, mark the path already applied.
5. If local diverged but the edit is non-overlapping text, perform a three-way text merge.
6. If the edit overlaps, involves deletion/binary content, or the base history is missing during an official update, produce a structured conflict for the install-update agent.

The agent sees a Stella conflict object, not a raw Git conflict. It gets the base, local, incoming, feature metadata, and behavior spec, then writes the resolution into the local tree. Stella commits that resolution as a local revision.

### Native Artifacts

Native helpers should not be hidden inside source history. They are official desktop-update artifacts:

- `sourceRevisionId` points to source changes.
- Official desktop releases keep publishing hydrated platform payloads, while the Stella history graph records the source identity separately from downloaded helpers.
- Desktop native-helper refresh checks latest and replaces the local helper bundle only when needed.
- Store packages do not publish or install native-helper artifacts. Store installs hand the agent a temporary package directory containing the spec, source pack, and reference diffs.

## Migration Path

1. Land the local source-control core beside the current Git-backed flow.
2. Publish Store releases with both the current blueprint/diff payload and a Stella source pack.
3. Feed Store installs and updates through the agent using the source pack and reference diffs as exact package input.
4. Keep improving the official update conflict handoff so large or complex conflicts are resolved from Stella conflict objects instead of raw Git conflict markers.
5. Keep native-helper refresh in the official desktop update path, where Stella can check latest and no-op when already current.
6. Keep Git as an internal compatibility layer only until launcher/install/update no longer need GitHub object fetches.

The prototype in `stella-source-control.ts` implements the first merge primitive: content-addressed changed-file packs, stable revision ids that do not require unchanged file contents, deterministic clean apply/noop behavior, grouped revision chains for feature installs/updates, a simple three-way text merge, and structured conflicts for agent resolution. The local SQLite history graph records hash-only revisions for self-mod and Store apply commits, and Store publishing now prefers that graph so shared packs keep Stella's own revision identity instead of minting a Git-derived one at upload time.
